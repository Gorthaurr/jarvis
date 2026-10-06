
export interface Obs {
  scene: string;
  scenes: string[];
  streaming: boolean;
  streamStart: number;
  recording: boolean;
  recordPaused: boolean;
  recordStart: number;
  muted: Map<string, boolean>;
  inputs: Array<{ inputName: string; inputKind: string }>;
  stream: { streamServiceType: string; streamServiceSettings: Record<string, unknown> };
}

export class ObsReject extends Error {
  constructor(readonly code: number, readonly comment: string) {
    super(comment);
  }
}
export const missing = (f: string): never => {
  throw new ObsReject(300, `Your request is missing a required field: \`${f}\``);
};
export const timecode = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}.${String(Math.floor(ms % 1000)).padStart(3, "0")}`;
};
export const uuid = (name: string): string => `lab-${Buffer.from(name).toString("hex").slice(0, 24)}`;
