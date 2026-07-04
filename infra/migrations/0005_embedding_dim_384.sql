-- =============================================================================
-- 0005 — Эмбеддинги: размерность 1536 → 384 (§1)
--
-- ЗАЧЕМ: дефолтный эмбеддер сменён с мусорного HashEmbeddingProvider (случайные векторы → память
-- «вспоминала» нерелевантное) на РЕАЛЬНУЮ локальную e5-small (384-dim) — см. integrations/local-
-- embeddings.ts. OpenAI (опт-ин) тоже усекается до 384 (dimensions). Канон столбца = VECTOR(384).
--
-- ДАННЫЕ: прежние векторы (hash-мусор ИЛИ старые 1536-OpenAI) НЕСОВМЕСТИМЫ и удаляются вместе со
-- столбцом — потери качества нет (hash и так был мусором). ТЕКСТ фактов сохраняется. После миграции
-- embedding=NULL → факт не вернётся в поиск, ПОКА не переэмбеддится. Бэкилл (опц., прод): пройти
-- episodic_memory с пустым embedding и переписать через эмбеддер (отдельный скрипт; на dev не нужен).
-- Идемпотентно (IF EXISTS / IF NOT EXISTS), применяется раннером infra/migrate.mjs один раз.
-- =============================================================================

-- HNSW-индекс зависит от столбца — снимаем явно (DROP COLUMN и так его уронил бы, но не полагаемся).
DROP INDEX IF EXISTS idx_episodic_embedding_hnsw;

-- Пересоздаём столбец с новой размерностью (старые векторы отбрасываются — были мусором/несовместимы).
ALTER TABLE episodic_memory DROP COLUMN IF EXISTS embedding;
ALTER TABLE episodic_memory ADD COLUMN embedding VECTOR(384);

COMMENT ON COLUMN episodic_memory.embedding IS '§1 384d: локальная multilingual-e5-small ИЛИ OpenAI text-embedding-3-small(dimensions=384). Смена модели/размерности → новая миграция + бэкилл.';

-- HNSW (инкрементальный, без обучения на пустой таблице).
CREATE INDEX IF NOT EXISTS idx_episodic_embedding_hnsw
    ON episodic_memory USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
