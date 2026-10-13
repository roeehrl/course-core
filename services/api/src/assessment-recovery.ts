import type {CourseManifest} from '@course-core/sdk';
import {learningSnapshot,type EvidenceRow,type ProgressRow} from './learning.js';
export interface ApprovedRecoveryFamily{episodeId:string;objectiveIds:string[];familyId:string;plannedMinutes:number;additionalEpisodes:number}
/** Delivery guidance only. Authoritative generation rechecks registry, evidence,
 * exposure, assistance, policy and cost in its enrollment transaction. */
export function assessmentRecovery(course:CourseManifest,digest:string,progress:ProgressRow[],evidence:EvidenceRow[],exposedIds:readonly string[],approved:readonly ApprovedRecoveryFamily[]){
  return learningSnapshot(course,digest,progress,evidence).lessons.flatMap(lesson=>{
    if(lesson.status!=='available'||!lesson.gate||lesson.gate.passed)return [];
    const episode=course.chapters.flatMap(c=>c.episodes).find(e=>e.id===lesson.id)!,gate=course.gates.find(g=>g.id===episode.gateId)!;
    const relevant=course.assessments.filter(a=>gate.assessmentIds.includes(a.id));
    if(relevant.some(a=>!exposedIds.includes(a.id)))return [];
    const missing=lesson.gate.objectives.filter(o=>!o.passed);
    const fresh=approved.find(f=>f.episodeId===lesson.id&&missing.some(o=>f.objectiveIds.includes(o.id)&&!o.families.includes(f.familyId)));
    const objective=fresh?missing.find(o=>fresh.objectiveIds.includes(o.id)&&!o.families.includes(fresh.familyId))!:undefined;
    return [{episodeId:lesson.id,required:true as const,freshCheck:fresh&&objective?{objectiveId:objective.id,familyId:fresh.familyId,plannedMinutes:fresh.plannedMinutes,additionalEpisodes:fresh.additionalEpisodes}:null}];
  });
}
