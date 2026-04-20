-- Drop redundant uniqueness on Deployment.port.
-- PortAllocation.port (PK) is the real source of truth.
DROP INDEX IF EXISTS "Deployment_port_key";
