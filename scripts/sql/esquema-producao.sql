SELECT c.relname AS tabela, a.attname AS coluna, format_type(a.atttypid, a.atttypmod) AS tipo, a.attnotnull AS obrigatoria,
       pg_get_expr(d.adbin, d.adrelid) AS padrao
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
 WHERE c.relkind = 'r'
 ORDER BY c.relname, a.attnum;
