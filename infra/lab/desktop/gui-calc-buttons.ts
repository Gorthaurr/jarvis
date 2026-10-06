
export type Op = "+" | "-" | "*" | "/";
export interface Btn {
  id: string;
  name: string;
  label: string;
  aid: string;
}

export const DIGITS = ["Ноль", "Один", "Два", "Три", "Четыре", "Пять", "Шесть", "Семь", "Восемь", "Девять"];
export const d = (n: number): Btn => ({ id: String(n), name: DIGITS[n]!, label: String(n), aid: `num${n}Button` });
export const GRID: Btn[][] = [
  [
    { id: "pct", name: "Процент", label: "%", aid: "percentButton" },
    { id: "ce", name: "Очистить запись", label: "CE", aid: "clearEntryButton" },
    { id: "c", name: "Очистить", label: "C", aid: "clearButton" },
    { id: "back", name: "Назад", label: "⌫", aid: "backSpaceButton" },
  ],
  [
    { id: "inv", name: "Обратная величина", label: "1/x", aid: "invertButton" },
    { id: "sq", name: "Возведение в квадрат", label: "x²", aid: "xpower2Button" },
    { id: "sqrt", name: "Квадратный корень", label: "√", aid: "squareRootButton" },
    { id: "/", name: "Разделить на", label: "÷", aid: "divideButton" },
  ],
  [d(7), d(8), d(9), { id: "*", name: "Умножить на", label: "×", aid: "multiplyButton" }],
  [d(4), d(5), d(6), { id: "-", name: "Минус", label: "−", aid: "minusButton" }],
  [d(1), d(2), d(3), { id: "+", name: "Плюс", label: "+", aid: "plusButton" }],
  [
    { id: "neg", name: "Плюс или минус", label: "±", aid: "negateButton" },
    d(0),
    { id: "dec", name: "Десятичный разделитель", label: ",", aid: "decimalSeparatorButton" },
    { id: "eq", name: "Равно", label: "=", aid: "equalButton" },
  ],
];
