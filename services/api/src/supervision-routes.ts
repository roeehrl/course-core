import type {FastifyInstance} from 'fastify';
import type {Database} from './database.js';
import type {authService} from './auth.js';
import {transaction} from './database.js';
import {enrollmentCommand,loadEnrollment,type CommandInput} from './repository.js';
import {requireCondition} from './errors.js';
import {appendEvent} from './events.js';

export function registerSupervisionRoutes(app:FastifyInstance,db:Database,auth:ReturnType<typeof authService>){
  const base='/api/enrollments/:enrollmentId/supervision',params={type:'object',additionalProperties:false,required:['enrollmentId'],properties:{enrollmentId:{type:'string',format:'uuid'}}};
  app.get(base,{schema:{params}},async request=>{
    const actor=await auth.authenticate(request),{enrollmentId}=request.params as {enrollmentId:string};
    return transaction(db,async client=>{const {enrollment}=await loadEnrollment(client,actor,enrollmentId,true);const row=(await client.query('SELECT revision,adaptive_teaching FROM supervisor_permissions WHERE enrollment_id=$1 AND workspace_id=$2',[enrollment.id,enrollment.workspace_id])).rows[0];
      return {revision:enrollment.revision,permissionRevision:row?.revision??0,adaptiveTeaching:row?.adaptive_teaching??false,authority:'learner_opt_in',doesNotGrantMastery:true};});
  });
  app.post(base,{schema:{params,body:{type:'object',additionalProperties:false,required:['expectedRevision','idempotencyKey','adaptiveTeaching'],properties:{expectedRevision:{type:'integer',minimum:1},idempotencyKey:{type:'string',minLength:8,maxLength:200},adaptiveTeaching:{type:'boolean'}}}}},async request=>{
    const actor=await auth.authenticate(request),{enrollmentId}=request.params as {enrollmentId:string},input=request.body as CommandInput&{adaptiveTeaching:boolean};
    return enrollmentCommand(db,actor,enrollmentId,'supervision.permission',input,async(client,loaded)=>{
      requireCondition(loaded.enrollment.user_id===actor.id,'LEARNER_CONSENT_REQUIRED',403);
      const row=(await client.query(`INSERT INTO supervisor_permissions(enrollment_id,workspace_id,adaptive_teaching,changed_by) VALUES($1,$2,$3,$4)
        ON CONFLICT(enrollment_id) DO UPDATE SET revision=supervisor_permissions.revision+1,adaptive_teaching=EXCLUDED.adaptive_teaching,changed_by=EXCLUDED.changed_by,updated_at=clock_timestamp() RETURNING revision`,[enrollmentId,loaded.enrollment.workspace_id,input.adaptiveTeaching,actor.id])).rows[0]!;
      await client.query('UPDATE enrollments SET revision=revision+1 WHERE id=$1',[enrollmentId]);
      await appendEvent(client,{workspaceId:loaded.enrollment.workspace_id,enrollmentId,actorId:actor.id,actorKind:'learner',type:'supervision.permission_changed',payload:{adaptiveTeaching:input.adaptiveTeaching,permissionRevision:row.revision},idempotencyKey:`supervision-permission:${enrollmentId}:${input.idempotencyKey}`,supervise:false});
      return {revision:loaded.enrollment.revision+1,permissionRevision:row.revision,adaptiveTeaching:input.adaptiveTeaching,authority:'learner_opt_in'};
    });
  });
  app.get(base+'/tools',{schema:{params}},async request=>{
    const actor=await auth.authenticate(request),{enrollmentId}=request.params as {enrollmentId:string};await transaction(db,client=>loadEnrollment(client,actor,enrollmentId,true));
    const rows=(await db.query('SELECT id,job_id AS "jobId",step,tool,outcome,created_at AS "createdAt" FROM supervisor_tool_calls WHERE enrollment_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50',[enrollmentId])).rows;
    // The ordinary timeline shows decisions and references, not pre-delivery text
    // that could become an assessment-help side channel after the job is fenced.
    return {calls:rows.map(r=>({...r,outcome:{available:r.outcome.result?.available??null,reason:r.outcome.result?.reason??null,selected:r.outcome.result?.selected??false,profileId:r.outcome.selection?.profileId??null,entryId:r.outcome.selection?.entryId??null,delivery:r.outcome.result?.delivery??null}}))};
  });
}
