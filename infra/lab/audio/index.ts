/** Аудио-стенд лаборатории: WAV → настоящий клиентский слух → сервер → озвучка. См. README.md. */
export { AudioStandUnavailable, createAudioStand } from "./stand.js";
export type { AudioStandEx, AudioStandOptions, AudioStandResultEx } from "./stand.js";
export { audioStandAvailability } from "./availability.js";
export { createMockClient, fakeMp3 } from "./mock-client.js";
export type { MockClient, MockScript } from "./mock-client.js";
export { CONDITIONS, buildCorpus, runCorpus, summarize } from "./corpus.js";
export type { CorpusItem, CorpusReport } from "./corpus.js";
export { formatReport, runCorpusReport } from "./corpus-report.js";
export { micChain, toFrames, shape, makeupCurve } from "./mic-model.js";
export { loadWav16k, parseWav, wavFromPcm16 } from "./wav.js";
export { makeNoise } from "./noise.js";
