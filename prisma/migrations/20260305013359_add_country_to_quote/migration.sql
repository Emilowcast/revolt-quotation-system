-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "country" TEXT DEFAULT 'MX',
ADD COLUMN     "esExtranjero" BOOLEAN DEFAULT false;
