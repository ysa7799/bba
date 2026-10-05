-- Grants the runtime role DML-only access. Run as an admin/owner connection.
-- Usage: psql "$URL" -v owner=businessos -v app=businessos_app -f grant-app-role.sql
GRANT CONNECT ON DATABASE :"DBNAME" TO :"app";
GRANT USAGE ON SCHEMA public TO :"app";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"app";
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO :"app";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"app";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO :"app";
