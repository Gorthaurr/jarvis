/** Привязывает начало мышиного/клавиатурного жеста к вопросу, который владелец тогда видел. */
export function bindConfirmGesture(
  element: HTMLElement,
  currentId: () => string | undefined,
  answer: (requestId: string) => void,
  backgroundOnly = false,
): () => void {
  let captured = false;
  let requestId: string | undefined;
  let pointerStarted = false;
  const accepts = (event: Event) => !backgroundOnly || event.target === element;
  const capture = () => { captured = true; requestId = currentId(); };
  const pointer = (event: PointerEvent) => {
    if (!accepts(event)) return;
    capture();
    pointerStarted = true;
  };
  const mouse = (event: MouseEvent) => {
    if (!accepts(event)) return;
    // mousedown после pointerdown — тот же жест, даже если между событиями истёк вопрос.
    if (!pointerStarted) capture();
    pointerStarted = false;
  };
  const key = (event: KeyboardEvent) => {
    if (accepts(event) && !event.repeat && (event.key === "Enter" || event.key === " ")) capture();
  };
  const click = (event: MouseEvent) => {
    if (!accepts(event) || event.detail > 1) return; // второй click не подтверждает следующий вопрос
    // HTMLElement.click() из ESC/denyConfirm — отдельное явное решение о текущем вопросе.
    const programmatic = !event.isTrusted && !event.detail;
    const id = programmatic || !captured ? currentId() : requestId;
    if (id && id === currentId()) answer(id);
  };
  element.addEventListener("pointerdown", pointer);
  element.addEventListener("mousedown", mouse);
  element.addEventListener("keydown", key);
  element.addEventListener("click", click);
  return () => {
    element.removeEventListener("pointerdown", pointer);
    element.removeEventListener("mousedown", mouse);
    element.removeEventListener("keydown", key);
    element.removeEventListener("click", click);
  };
}
