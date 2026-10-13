-- Full-text catalog search: a weighted tsvector per course (name and short name A,
-- category B, summary text C) in Russian and English, plus trigrams on the name for
-- partial words and typos. Triggers keep it current however a course is written.

-- AlterTable
ALTER TABLE "Course" ADD COLUMN     "tsv" tsvector;

-- CreateIndex
CREATE INDEX "Course_tsv_idx" ON "Course" USING GIN ("tsv");

-- CreateIndex
CREATE INDEX "Course_fullName_idx" ON "Course" USING GIN ("fullName" gin_trgm_ops);

-- ё and е are one letter for searching
CREATE FUNCTION hubium_course_tsv(full_name text, short_name text, summary text, category text)
RETURNS tsvector LANGUAGE sql IMMUTABLE AS $$
  SELECT
    setweight(to_tsvector('simple', translate(coalesce(short_name, ''), 'ёЁ', 'еЕ')), 'A') ||
    setweight(to_tsvector('russian', translate(coalesce(full_name, ''), 'ёЁ', 'еЕ')), 'A') ||
    setweight(to_tsvector('english', coalesce(full_name, '')), 'A') ||
    setweight(to_tsvector('russian', translate(coalesce(category, ''), 'ёЁ', 'еЕ')), 'B') ||
    setweight(to_tsvector('english', coalesce(category, '')), 'B') ||
    setweight(to_tsvector('russian',
      translate(regexp_replace(coalesce(summary, ''), '<[^>]*>', ' ', 'g'), 'ёЁ', 'еЕ')), 'C') ||
    setweight(to_tsvector('english', regexp_replace(coalesce(summary, ''), '<[^>]*>', ' ', 'g')), 'C')
$$;

CREATE FUNCTION hubium_course_tsv_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."tsv" := hubium_course_tsv(NEW."fullName", NEW."shortName", NEW."summary",
    (SELECT name FROM "Category" WHERE id = NEW."categoryId"));
  RETURN NEW;
END
$$;

CREATE TRIGGER "Course_tsv"
  BEFORE INSERT OR UPDATE OF "fullName", "shortName", "summary", "categoryId" ON "Course"
  FOR EACH ROW EXECUTE FUNCTION hubium_course_tsv_trigger();

CREATE FUNCTION hubium_category_course_tsv_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "Course" SET "tsv" = hubium_course_tsv("fullName", "shortName", "summary", NEW.name)
   WHERE "categoryId" = NEW.id;
  RETURN NULL;
END
$$;

CREATE TRIGGER "Category_course_tsv"
  AFTER UPDATE OF name ON "Category"
  FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION hubium_category_course_tsv_trigger();

-- existing courses
UPDATE "Course" c
   SET "tsv" = hubium_course_tsv(c."fullName", c."shortName", c."summary", cat.name)
  FROM "Category" cat
 WHERE cat.id = c."categoryId";
