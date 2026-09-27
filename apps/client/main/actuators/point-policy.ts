/**
 * W2: политика «что под точкой» — общая для act-find (П5: OCR-ступень, G-12) и рубежа §14 (П1: G-10 — invoke только
 * малого элемента, иначе физический клик ровно в точку). Вынесено из act-find.ts без изменения поведения.
 *
 * Ревью 2026-09-24 (H-A1): сайдкар отдаёт под точкой actionable-предка, а если такого нет — САМ элемент, и в играх/
 * Electron это контейнер на пол-окна (живая проба: Group 1343×756 без имени). Клик по его handle = клик в ЦЕНТР
 * контейнера, а не в найденную точку, с отчётом «нажал». Крупный элемент под точкой — не кнопка: берём только точку.
 * Порог — в ФИЗИЧЕСКИХ пикселях (bbox сайдкара), с запасом на масштаб 150–200 %.
 */

export const MAX_ACTIONABLE_W = 600;
export const MAX_ACTIONABLE_H = 300;

export function looksLikeContainer(bbox: { w: number; h: number } | undefined): boolean {
  return !!bbox && (bbox.w > MAX_ACTIONABLE_W || bbox.h > MAX_ACTIONABLE_H);
}

/**
 * G-10 (П1): бесшумный invoke по ТОЧКЕ — только МАЛОГО элемента (кнопка, иконка), размер в DIP. Строка списка 400×64
 * с «×» внутри: invoke её handle сделал бы действие строки ПО УМОЛЧАНИЮ (открыть чат), а целились в «×». Крупнее
 * порога — физический клик ровно в точку; рубеж §14 судит элемент ПОД ней.
 */
export const MAX_INVOKE_W_DIP = 240;
export const MAX_INVOKE_H_DIP = 60;

export function invokableAtPoint(bboxDip: { w: number; h: number } | undefined): boolean {
  return !!bboxDip && bboxDip.w > 0 && bboxDip.h > 0 && bboxDip.w <= MAX_INVOKE_W_DIP && bboxDip.h <= MAX_INVOKE_H_DIP;
}
