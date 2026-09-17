-- AlterTable
ALTER TABLE `VideoAnalytics` ADD COLUMN `regionalFit` JSON NULL;

-- CreateTable
CREATE TABLE `CopyQualityCheck` (
    `id` VARCHAR(191) NOT NULL,
    `languageMode` VARCHAR(191) NOT NULL DEFAULT 'auto',
    `pastedCopy` TEXT NOT NULL,
    `spellingScore` INTEGER NULL,
    `grammarScore` INTEGER NULL,
    `logicScore` INTEGER NULL,
    `clarityScore` INTEGER NULL,
    `findings` JSON NOT NULL,
    `checkedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `videoId` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `CopyQualityCheck_videoId_key`(`videoId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `CopyQualityCheck` ADD CONSTRAINT `CopyQualityCheck_videoId_fkey` FOREIGN KEY (`videoId`) REFERENCES `Video`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
