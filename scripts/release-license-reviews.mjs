import {createHash} from 'node:crypto';

/** Reviewed exceptions for missing THIRD-PARTY metadata, never a generic fallback
 * or a replacement for first-party package license declarations. Package version
 * and distributed license bytes must match the reviewed primary source exactly. */
export const LICENSE_FILE_REVIEWS=Object.freeze({
  'unionfs@4.6.0':Object.freeze({
    declaration:'Unlicense',filename:'LICENSE',
    sha256:'6b0382b16279f26ff69014300541967a356a666eb0b91b422f6862f6b7dad17e',
    source:'https://raw.githubusercontent.com/streamich/unionfs/v4.6.0/LICENSE',
    reviewedAt:'2026-10-12T22:30:00Z',
  }),
});
export function reviewedLicenseFile(name,version,texts){
  const review=LICENSE_FILE_REVIEWS[`${name}@${version}`];
  if(!review)throw new Error(`Missing license declaration for ${name}@${version}; no reviewed file exception`);
  const files=texts.filter(t=>t.filename===review.filename);
  if(files.length!==1||createHash('sha256').update(files[0].text).digest('hex')!==review.sha256)throw new Error(`Reviewed license file changed or missing for ${name}@${version}`);
  return {...review,basis:'reviewed_distributed_license_file'};
}
