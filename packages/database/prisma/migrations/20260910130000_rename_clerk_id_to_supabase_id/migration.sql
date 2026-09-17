-- Auth provider switch: Clerk -> Supabase Auth.
-- Written by hand (not `prisma migrate dev`, which wanted to drop+recreate
-- the column since the field name changed) as a true rename so the one
-- existing User row keeps its identity instead of losing its `clerkId`
-- value to a dropped-column migration.

ALTER TABLE `User` RENAME COLUMN `clerkId` TO `supabaseId`;
ALTER TABLE `User` RENAME INDEX `User_clerkId_key` TO `User_supabaseId_key`;
ALTER TABLE `User` RENAME INDEX `User_clerkId_idx` TO `User_supabaseId_idx`;
