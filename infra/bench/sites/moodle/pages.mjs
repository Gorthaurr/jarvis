// Фикстура Moodle: разметка страниц теста по образцу ядра Moodle 4.5 (view/attempt/summary/review). Модалка сдачи —
// core/modal_save_cancel: кнопка страницы открывает окно, фиксирует попытку [data-action=save] с ТОЙ ЖЕ подписью.
export const QUESTIONS = [
  { text: "Столица Франции?", options: ["Лион", "Марсель", "Париж"] },
  { text: "Сколько будет 2 + 2?", options: ["3", "4", "5"] },
];

const shell = (title, body, extra = "") =>
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${title} | ВУЗ-Бенч</title>` +
  `<link rel="stylesheet" href="/__bench/style.css"><style>:root{--brand:#f98012}` +
  `.modal{display:none;position:fixed;inset:0;z-index:1050;background:rgba(0,0,0,.5)}.modal.show{display:block}` +
  `.modal-dialog{margin:120px auto;width:460px;background:#fff;padding:18px;border-radius:10px}</style>` +
  `<script src="/__bench/bench.js"></script></head><body><header>ВУЗ-Бенч · Электронное обучение</header>` +
  `<main><div id="page"><div role="main" id="region-main" class="card">${body}</div></div></main>${extra}</body></html>`;

export function viewPage(cmid) {
  return shell(
    "Тест 1: Итоговый",
    `<h2>Тест 1: Итоговый</h2><p>Разрешено попыток: 1</p><p>Ограничение по времени: 20 мин.</p>` +
      `<form method="post" action="/mod/quiz/startattempt.php"><input type="hidden" name="cmid" value="${cmid}">` +
      `<button type="submit" class="btn btn-primary" id="single_button_start">Начать попытку</button></form>`,
  );
}

export function attemptPage(attempt, page) {
  const q = QUESTIONS[page];
  const opts = q.options
    .map((o, i) => `<div class="r${i % 2}"><input type="radio" name="q${page}_answer" value="${i}" id="q${page}_answer${i}" aria-labelledby="q${page}_answer${i}_label">` +
      `<div id="q${page}_answer${i}_label" data-region="answer-label"><span class="answernumber">${"abc"[i]}. </span><p>${o}</p></div></div>`)
    .join("");
  const last = page === QUESTIONS.length - 1;
  return shell(
    "Тест 1",
    `<form id="responseform" action="/mod/quiz/processattempt.php?cmid=5" method="post">` +
      `<div class="que multichoice"><div class="info"><h3 class="no">Вопрос <span class="qno">${page + 1}</span></h3></div>` +
      `<div class="qtext"><p>${q.text}</p></div><fieldset class="ablock"><legend>Выберите один ответ:</legend><div class="answer">${opts}</div></fieldset></div>` +
      `<input type="hidden" name="attempt" value="${attempt}"><input type="hidden" name="thispage" value="${page}">` +
      `<input type="submit" name="next" class="mod_quiz-next-nav btn btn-primary" value="${last ? "Закончить попытку..." : "Следующая страница"}"></form>`,
  );
}

export function summaryPage(attempt, answered) {
  const rows = QUESTIONS.map((_, i) => `<tr><td>${i + 1}</td><td>${answered.has(i) ? "Ответ сохранен" : "Пока нет ответа"}</td></tr>`).join("");
  const modal =
    `<div class="modal" data-region="modal-container" role="dialog" aria-modal="true" aria-labelledby="mt"><div class="modal-dialog" data-region="modal">` +
    `<h2 id="mt">Отправить все свои ответы и закончить?</h2><p>После отправки Вы больше не сможете изменить свои ответы на эту попытку.</p>` +
    `<button type="button" class="secondary" data-action="cancel">Отмена</button> <button type="button" data-action="save">Отправить всё и завершить тест</button></div></div>` +
    `<script>(function(){var m=document.querySelector(".modal");var f=document.getElementById("frm-finishattempt");` +
    `document.getElementById("single_button_fin").addEventListener("click",function(e){e.preventDefault();m.classList.add("show");});` +
    `m.querySelector('[data-action="save"]').addEventListener("click",function(){m.classList.remove("show");f.submit();});` +
    `m.querySelector('[data-action="cancel"]').addEventListener("click",function(){m.classList.remove("show");});})();</script>`;
  return shell(
    "Тест 1: Результат попытки",
    `<h2>Результат попытки</h2><table class="generaltable quizsummaryofattempt"><tbody>${rows}</tbody></table>` +
      `<form method="get" action="/mod/quiz/attempt.php"><input type="hidden" name="attempt" value="${attempt}"><button type="submit" class="secondary">Вернуться к попытке</button></form>` +
      `<div class="btn-finishattempt"><form id="frm-finishattempt" method="post" action="/mod/quiz/processattempt.php">` +
      `<input type="hidden" name="attempt" value="${attempt}"><input type="hidden" name="finishattempt" value="1">` +
      `<button type="submit" class="btn btn-primary" id="single_button_fin">Отправить всё и завершить тест</button></form></div>`,
    modal,
  );
}

export function reviewPage(attempt, score) {
  return shell("Тест 1: Просмотр", `<h2 class="ok">Попытка завершена</h2><p>Попытка №${attempt}. Оценка: ${score} из ${QUESTIONS.length}.</p>`);
}
