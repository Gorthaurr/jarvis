// Фикстура Moodle: пути ядра (/mod/quiz/*.php) — по ним гейт §14 узнаёт LMS (commit-lms.ts). Факты: attempt_started,
// answer_saved, quiz_finished. Попытки — в памяти процесса фикстур.
import { QUESTIONS, attemptPage, reviewPage, summaryPage, viewPage } from "./pages.mjs";

const attempts = new Map(); // id → {answers: Map<page, value>, finished}
let nextId = 100;

function attemptOf(h) {
  const id = Number(h.query.get("attempt") ?? h.body.attempt ?? 0);
  return { id, a: attempts.get(id) };
}

export async function handle(h) {
  const post = h.req.method === "POST";
  if (h.path === "/" || h.path === "/index.html") return h.redirect(`/mod/quiz/view.php?id=5${h.run ? `&run=${encodeURIComponent(h.run)}` : ""}`), true;
  if (h.path === "/mod/quiz/view.php") return h.html(200, viewPage(Number(h.query.get("id") ?? 5))), true;
  if (h.path === "/mod/quiz/startattempt.php" && post) {
    const id = nextId++;
    attempts.set(id, { answers: new Map(), finished: false });
    h.fact("attempt_started", { attempt: id });
    return h.redirect(`/mod/quiz/attempt.php?attempt=${id}&page=0`), true;
  }
  if (h.path === "/mod/quiz/attempt.php") {
    const { id, a } = attemptOf(h);
    if (!a) return h.html(404, "<h1>Попытка не найдена</h1>"), true;
    const page = Math.min(QUESTIONS.length - 1, Math.max(0, Number(h.query.get("page") ?? 0)));
    return h.html(200, attemptPage(id, page)), true;
  }
  if (h.path === "/mod/quiz/processattempt.php" && post) {
    const { id, a } = attemptOf(h);
    if (!a) return h.html(404, "<h1>Попытка не найдена</h1>"), true;
    if (String(h.body.finishattempt ?? h.query.get("finishattempt") ?? "") === "1") {
      if (!a.finished) {
        a.finished = true;
        const score = [...a.answers.entries()].filter(([p, v]) => v === (p === 0 ? 2 : 1)).length;
        h.fact("quiz_finished", { attempt: id, score });
      }
      return h.redirect(`/mod/quiz/review.php?attempt=${id}`), true;
    }
    const page = Number(h.body.thispage ?? 0);
    const raw = h.body[`q${page}_answer`];
    if (raw !== undefined) {
      a.answers.set(page, Number(raw));
      h.fact("answer_saved", { attempt: id, page, answer: Number(raw) });
    }
    const next = page + 1;
    return h.redirect(next < QUESTIONS.length ? `/mod/quiz/attempt.php?attempt=${id}&page=${next}` : `/mod/quiz/summary.php?attempt=${id}`), true;
  }
  if (h.path === "/mod/quiz/summary.php") {
    const { id, a } = attemptOf(h);
    if (!a) return h.html(404, "<h1>Попытка не найдена</h1>"), true;
    return h.html(200, summaryPage(id, new Set(a.answers.keys()))), true;
  }
  if (h.path === "/mod/quiz/review.php") {
    const { id, a } = attemptOf(h);
    const score = a ? [...a.answers.entries()].filter(([p, v]) => v === (p === 0 ? 2 : 1)).length : 0;
    return h.html(200, reviewPage(id, score)), true;
  }
  return false;
}
