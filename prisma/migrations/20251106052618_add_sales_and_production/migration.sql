/*
  Warnings:

  - You are about to drop the column `tipo` on the `Client` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Client" DROP COLUMN "tipo";

-- CreateTable
CREATE TABLE "Sale" (
    "id" SERIAL NOT NULL,
    "folio" TEXT NOT NULL,
    "quoteId" INTEGER NOT NULL,
    "clientId" INTEGER,
    "subtotal" DOUBLE PRECISION NOT NULL,
    "discount" DOUBLE PRECISION NOT NULL,
    "tax" DOUBLE PRECISION NOT NULL,
    "total" DOUBLE PRECISION NOT NULL,
    "netMxn" DOUBLE PRECISION,
    "exchangeRate" DOUBLE PRECISION,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'pendiente',
    "paymentStatus" TEXT NOT NULL DEFAULT 'pendiente',
    "deliveryStatus" TEXT NOT NULL DEFAULT 'pendiente',
    "createdById" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleItem" (
    "id" SERIAL NOT NULL,
    "saleId" INTEGER NOT NULL,
    "productId" INTEGER,
    "modelo" TEXT NOT NULL,
    "descripcion" TEXT,
    "unitPrice" DOUBLE PRECISION NOT NULL,
    "qty" INTEGER NOT NULL,
    "subtotal" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SaleItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionOrder" (
    "id" SERIAL NOT NULL,
    "folio" TEXT NOT NULL,
    "saleId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pendiente',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "dueDate" TIMESTAMP(3),
    "startDate" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "notes" TEXT,
    "excelPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductionOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Sale_folio_key" ON "Sale"("folio");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_quoteId_key" ON "Sale"("quoteId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionOrder_folio_key" ON "ProductionOrder"("folio");

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionOrder" ADD CONSTRAINT "ProductionOrder_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
