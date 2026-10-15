const armyOfficerGuideUrl = "https://home.army.mil/knox/5115/6624/4724/Officer_Eliminations_Process.pdf";
const navyOfficerTransferUrl = "https://www.mynavyhr.navy.mil/Portals/55/Reference/MILPERSMAN/1000/1900Separation/1920-010.pdf";
const voyageChunkId = (url, chunk) => `voyage-${encodeURIComponent(url)}-chunk-${chunk}`;

export const dd214PathwayChunkIds = [
  "localPdf-133601p-pdf-chunk-5",
  "localPdf-133601p-pdf-chunk-11",
  "localPdf-133601p-pdf-chunk-12",
  "localPdf-133601p-pdf-chunk-13",
];
export const dodFmrBahRequiredChunkIds = [
  "localPdf-Volume-07a-pdf-chunk-373",
  "localPdf-Volume-07a-pdf-chunk-824",
];

export const PINNED_SECTIONS = [
  {
    pattern: /\b(IDT|inactive.duty.training|drill.*travel|travel.*drill|round.trip.*IDT|IDT.*round.trip|commut.*IDT|IDT.*commut|reimburs.*IDT|IDT.*reimburs|travel.*reimburs|reimburs.*travel|drill.*reimburs|reimburs.*drill|IDT.*allowance|allowance.*IDT)\b/i,
    label: "JTR §032303–032304: IDT Travel Allowances",
    ids: [".%2Fjtr.pdf-chunk-136", ".%2Fjtr.pdf-chunk-137"],
  },
  {
    pattern: /\b(AR\s*600-8-24|active(?:-duty|\s+duty).{0,30}Army.{0,30}officer|Army.{0,30}officer.{0,30}(elimination|separation))\b/i,
    label: "AR 600-8-24: Active-duty Army officer eliminations",
    ids: Array.from({ length: 6 }, (_, i) => voyageChunkId(armyOfficerGuideUrl, i + 1)),
  },
  {
    pattern: /\b(MILPERSMAN\s*1920-010|transfer.{0,40}(officer|administrative separation).{0,30}process|officer.{0,30}transfer.{0,40}separation)\b/i,
    label: "MILPERSMAN 1920-010: Officer transfer for separation processing",
    ids: [voyageChunkId(navyOfficerTransferUrl, 1), voyageChunkId(navyOfficerTransferUrl, 2)],
  },
];

export const PINNED_ID_GROUPS = [
  { label: "JTR IDT travel", ids: PINNED_SECTIONS[0].ids },
  { label: "DoDI 1336.01 DD Form 214-1", ids: dd214PathwayChunkIds },
  { label: "DoD FMR Volume 7A BAH", ids: dodFmrBahRequiredChunkIds },
  { label: "AR 600-8-24", ids: PINNED_SECTIONS[1].ids },
  { label: "MILPERSMAN 1920-010", ids: PINNED_SECTIONS[2].ids },
];

export async function verifyPinnedChunks(index) {
  const ids = [...new Set(PINNED_ID_GROUPS.flatMap(group => group.ids))];
  // Fetch small batches: the index imposes limits on the combined length of IDs.
  const records = {};
  for (let start = 0; start < ids.length; start += 8) {
    const fetched = await index.fetch(ids.slice(start, start + 8));
    Object.assign(records, fetched.records || {});
  }
  return PINNED_ID_GROUPS.map(group => ({
    label: group.label,
    present: group.ids.filter(id => Boolean(records[id]?.metadata?.text)),
    missing: group.ids.filter(id => !records[id]?.metadata?.text),
  }));
}