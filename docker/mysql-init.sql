-- Local development grants: Prisma Migrate needs global CREATE/DROP to
-- manage its shadow database when diffing migrations.
GRANT ALL PRIVILEGES ON *.* TO 'vip'@'%';
FLUSH PRIVILEGES;
