import type { TurnResult } from "../lib/contracts.js";
import type { FakePlayer } from "./fake-player.js";
import type { ServerFeedback } from "./feedback.js";
import type { HearingRig } from "./hearing-rig.js";

interface AudioTurnState {
  fb: ServerFeedback;
  player: FakePlayer;
  rig: HearingRig;
  quietMs: number;
  grace: number;
  playerChangedAt(): number;
}

/** Ждём конец хода: сервер вернулся из thinking/speaking, плеер доиграл, задачи завершены, тишина quietMs. */
export async function settleAudioTurn(state: AudioTurnState, lastFrameAt: number, timeoutMs: number): Promise<TurnResult["ended"]> {
  const { fb, player, rig, quietMs, grace } = state;
  const deadline = Date.now() + timeoutMs;
  for (; ;) {
    fb.drain();
    const now = Date.now();
    if (now > deadline) return "timeout";
    const quiet = now - Math.max(fb.lastEventAt, state.playerChangedAt(), lastFrameAt);
    const heard = rig.probe.gateOpened || rig.probe.rescueSent;
    if (!fb.engaged) {
      if (heard ? now - lastFrameAt >= grace : quiet >= quietMs) return "idle";
    } else if (fb.state !== "thinking" && fb.state !== "speaking" && !player.active && fb.tasksDone && quiet >= quietMs) {
      return fb.tasks.size > 0 ? "task_done" : "idle";
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
