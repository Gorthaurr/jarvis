// Мини-проект для e2e-теста флейк-скана (запускается ИЗ теста scan.test.ts; лабораторный vitest его не подбирает: *.spec.mjs).
import { tempTestConfig } from "../../../testing/vitest-temp-config.ts";

export default { test: { ...tempTestConfig, include: ["*.spec.mjs"] } };
