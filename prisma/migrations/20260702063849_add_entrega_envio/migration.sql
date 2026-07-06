-- DropForeignKey
ALTER TABLE "public"."Sale" DROP CONSTRAINT "Sale_quoteId_fkey";

-- AlterTable
ALTER TABLE "ProductionOrder" ADD COLUMN     "adicionales" TEXT,
ADD COLUMN     "esTransformador" BOOLEAN DEFAULT false,
ADD COLUMN     "observaciones" TEXT,
ADD COLUMN     "voltajeEntrada" TEXT,
ADD COLUMN     "voltajeMaxEntrada" TEXT,
ADD COLUMN     "voltajeMinEntrada" TEXT,
ADD COLUMN     "voltajeSalida" TEXT;

-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "adicionales" JSONB,
ADD COLUMN     "entregaEnvio" TEXT;

-- AlterTable
ALTER TABLE "QuoteItem" ADD COLUMN     "categoryType" TEXT,
ADD COLUMN     "providerCost" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Sale" ALTER COLUMN "quoteId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "SaleItem" ADD COLUMN     "categoryType" TEXT,
ADD COLUMN     "providerCost" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailFrom" TEXT,
ADD COLUMN     "emailPassword" TEXT;

-- CreateTable
CREATE TABLE "Config" (
    "id" SERIAL NOT NULL,
    "clave" TEXT NOT NULL,
    "valor" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Config_clave_key" ON "Config"("clave");

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;
