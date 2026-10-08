-- Up Migration

-- pgvector: photo/description embeddings (1024 dims, step 6). pgcrypto: gen_random_bytes /
-- digest for hashed share-link tokens and invite codes (step 2+). Both are IF NOT EXISTS so a
-- re-run is a no-op.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Down Migration

-- No table uses these types yet (step 1), so a plain DROP is safe. Later migrations that add
-- vector columns must be reverted first, which node-pg-migrate guarantees by running downs in
-- reverse order.
DROP EXTENSION IF EXISTS pgcrypto;
DROP EXTENSION IF EXISTS vector;
