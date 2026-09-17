-- AlterTable
ALTER TABLE `Video` ADD COLUMN `variantGroupId` VARCHAR(191) NULL,
    ADD COLUMN `variantLabel` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `VideoAnalytics` ADD COLUMN `calibrated` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `VariantGroup` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `teamId` VARCHAR(191) NOT NULL,

    INDEX `VariantGroup_teamId_idx`(`teamId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `VariantGroup` ADD CONSTRAINT `VariantGroup_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Video` ADD CONSTRAINT `Video_variantGroupId_fkey` FOREIGN KEY (`variantGroupId`) REFERENCES `VariantGroup`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
