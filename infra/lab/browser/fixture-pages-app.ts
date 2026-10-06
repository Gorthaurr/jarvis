/**
 * Страницы-фикстуры, часть 2 (действия): форма входа (только структура, реального пароля нет), оформление заказа с
 * кнопкой-коммитом для §14-гарда, iframe, динамическая подгрузка. Журнал событий страницы — единственный источник
 * правды «нажалось ли»: пароль в журнал не попадает никогда, только факт «поле заполнено».
 */
import { page } from "./fixture-pages.js";

export const LOGIN = page(
  "Вход в стенд",
  `<h1>Вход</h1><form id="f" autocomplete="off">
<label>Логин <input name="login" type="text" placeholder="логин"></label>
<label>Пароль <input name="pass" type="password" placeholder="пароль"></label>
<button type="submit">Войти</button></form><div id="res"></div>
<script>document.getElementById('f').addEventListener('submit',e=>{e.preventDefault();const f=e.target;
labEvent('login_submit',{login:f.login.value,passwordFilled:f.pass.value.length>0});
document.getElementById('res').textContent='Форма отправлена (стенд)'})</script>`,
);

/** Безобидная кнопка и две коммит-кнопки: подпись «Оплатить»/«Отправить» узнаёт страничный гард на любом хосте. */
export const CHECKOUT = page(
  "Оформление заказа",
  `<h1>Оформление заказа</h1>
<button id="details" onclick="labEvent('details_shown');document.getElementById('info').hidden=false">Показать детали</button>
<div id="info" hidden>Доставка: самовывоз, итого 1234 руб.</div>
<button id="pay" onclick="labEvent('pay',{trusted:event.isTrusted})">Оплатить заказ</button>
<form id="ord"><input type="submit" value="Отправить заказ"></form>
<script>document.getElementById('ord').addEventListener('submit',e=>{e.preventDefault();labEvent('order_submitted')})</script>`,
);

export const FRAME_INNER = page(
  "Внутренняя рамка",
  `<h2>Внутри рамки</h2><button onclick="labEvent('inner_clicked');this.textContent='Панель открыта'">Открыть панель в рамке</button>`,
);

export const FRAME = page(
  "Страница с рамкой",
  `<h1>Снаружи</h1><button onclick="labEvent('outer_clicked')">Внешняя кнопка</button>
<iframe src="/frame-inner" title="внутренняя рамка" width="420" height="140"></iframe>`,
);

/** Кнопка появляется через 700 мс, список растёт по клику через fetch: снимок «до» и «после» различаются. */
export const DYNAMIC = page(
  "Динамическая страница",
  `<h1>Динамическая страница</h1><p id="status">Загрузка…</p><ul id="list"></ul><div id="slot"></div>
<script>setTimeout(()=>{document.getElementById('status').textContent='Готово';
const b=document.createElement('button');b.textContent='Загрузить ещё';b.id='more';
b.onclick=async()=>{const r=await fetch('/api/items?page=2');const j=await r.json();
for(const t of j.items){const li=document.createElement('li');li.textContent=t;document.getElementById('list').appendChild(li)}
labEvent('items_loaded',{count:j.items.length})};document.getElementById('slot').appendChild(b);
const li=document.createElement('li');li.textContent='Позиция 1';document.getElementById('list').appendChild(li)},700)</script>`,
);

/** Кнопка вешает главный поток страницы: ответа расширения не будет — исход клика «неизвестен» (закон 1). */
export const HANG = page(
  "Зависающая страница",
  `<h1>Зависающая страница</h1><button onclick="labEvent('hang_started');setTimeout(()=>{while(true){}},50)">Зависнуть</button>`,
);

export const ITEMS_PAGE_2 = { items: ["Позиция 2", "Позиция 3", "Позиция 4"] };
