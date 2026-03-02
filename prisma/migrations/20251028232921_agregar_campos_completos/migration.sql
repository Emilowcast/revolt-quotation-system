-- DropForeignKey
ALTER TABLE "public"."QuoteItem" DROP CONSTRAINT "QuoteItem_quoteId_fkey";

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "estado" TEXT,
ADD COLUMN     "tipo" TEXT;

-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "exchangeRate" DOUBLE PRECISION,
ADD COLUMN     "netMxn" DOUBLE PRECISION,
ADD COLUMN     "template" TEXT;

-- AddForeignKey
ALTER TABLE "QuoteItem" ADD CONSTRAINT "QuoteItem_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;
