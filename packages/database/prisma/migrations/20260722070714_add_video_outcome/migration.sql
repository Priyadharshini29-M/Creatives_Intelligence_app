-- CreateTable
CREATE TABLE `VideoOutcome` (
    `id` VARCHAR(191) NOT NULL,
    `hookRate` DOUBLE NULL,
    `holdRate` DOUBLE NULL,
    `conversionScore` DOUBLE NULL,
    `source` VARCHAR(191) NOT NULL,
    `notes` TEXT NULL,
    `recordedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `videoId` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `VideoOutcome_videoId_key`(`videoId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `VideoOutcome` ADD CONSTRAINT `VideoOutcome_videoId_fkey` FOREIGN KEY (`videoId`) REFERENCES `Video`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
