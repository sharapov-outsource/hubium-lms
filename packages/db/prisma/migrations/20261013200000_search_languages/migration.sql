-- Full-text search in the languages of the installed language packs. Their PostgreSQL
-- configurations ("$language.fts" of each pack) are kept by the seed in the site setting
-- 'search.ftsConfigs', which then calls hubium_reindex_search(). Accents are ignored like
-- ё and е: élève finds eleve, Übung finds ubung. 'simple' is always added, so names, codes
-- and languages without a configuration of their own are still found word by word.

CREATE FUNCTION hubium_search_configs() RETURNS regconfig[] LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT array_agg(c.oid::regconfig ORDER BY c.cfgname)
       FROM pg_ts_config c
      WHERE c.cfgname <> 'simple'
        AND c.cfgname IN (
          SELECT jsonb_array_elements_text(value) FROM "SiteSetting"
           WHERE key = 'search.ftsConfigs' AND jsonb_typeof(value) = 'array')),
    ARRAY['russian', 'english']::regconfig[])
$$;

-- A text in every search language, with one weight.
CREATE FUNCTION hubium_text_tsv(body text, weight "char") RETURNS tsvector
LANGUAGE plpgsql STABLE AS $$
DECLARE
  folded text := unaccent(coalesce(body, ''));
  cfg regconfig;
  v tsvector := setweight(to_tsvector('simple', folded), weight);
BEGIN
  FOREACH cfg IN ARRAY hubium_search_configs() LOOP
    v := v || setweight(to_tsvector(cfg, folded), weight);
  END LOOP;
  RETURN v;
END
$$;

-- One word as a prefix (word:*) in every search language. `term` holds letters and digits only.
CREATE FUNCTION hubium_prefix_query(term text) RETURNS tsquery LANGUAGE plpgsql STABLE AS $$
DECLARE
  folded text := unaccent(term) || ':*';
  cfg regconfig;
  q tsquery := to_tsquery('simple', folded);
BEGIN
  FOREACH cfg IN ARRAY hubium_search_configs() LOOP
    q := q || to_tsquery(cfg, folded);
  END LOOP;
  RETURN q;
END
$$;

-- A query as people type it ("quotes", or, -word) in every search language.
CREATE FUNCTION hubium_websearch(query text) RETURNS tsquery LANGUAGE plpgsql STABLE AS $$
DECLARE
  folded text := unaccent(coalesce(query, ''));
  cfg regconfig;
  q tsquery := websearch_to_tsquery('simple', folded);
BEGIN
  FOREACH cfg IN ARRAY hubium_search_configs() LOOP
    q := q || websearch_to_tsquery(cfg, folded);
  END LOOP;
  RETURN q;
END
$$;

CREATE OR REPLACE FUNCTION hubium_course_tsv(full_name text, short_name text, summary text, category text)
RETURNS tsvector LANGUAGE sql STABLE AS $$
  SELECT setweight(to_tsvector('simple', unaccent(coalesce(short_name, ''))), 'A')
      || hubium_text_tsv(full_name, 'A')
      || hubium_text_tsv(category, 'B')
      || hubium_text_tsv(regexp_replace(coalesce(summary, ''), '<[^>]*>', ' ', 'g'), 'C')
$$;

-- Rebuilds the search vectors of courses and AI content chunks (after the languages changed).
CREATE FUNCTION hubium_reindex_search() RETURNS void LANGUAGE sql AS $$
  UPDATE "Course" c
     SET "tsv" = hubium_course_tsv(c."fullName", c."shortName", c."summary", cat.name)
    FROM "Category" cat
   WHERE cat.id = c."categoryId";
  UPDATE "ContentChunk"
     SET "tsv" = hubium_text_tsv(coalesce("title", '') || E'\n' || "text", 'D');
$$;

SELECT hubium_reindex_search();
