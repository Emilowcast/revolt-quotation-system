/*
  Warnings:

  - A unique constraint covering the columns `[orderNumber]` on the table `ProductionOrder` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "ProductionOrder" ADD COLUMN     "clientName" TEXT DEFAULT 'Cliente',
ADD COLUMN     "createdById" INTEGER,
ADD COLUMN     "orderNumber" TEXT,
ADD COLUMN     "productDescription" TEXT,
ADD COLUMN     "productModel" TEXT DEFAULT 'N/A',
ADD COLUMN     "quantity" INTEGER DEFAULT 1,
ALTER COLUMN "folio" DROP NOT NULL,
ALTER COLUMN "status" SET DEFAULT 'pending',
ALTER COLUMN "priority" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "convertedToSaleAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "formaPago" TEXT,
ADD COLUMN     "template" TEXT,
ADD COLUMN     "tiempoEntrega" TEXT,
ALTER COLUMN "paymentStatus" SET DEFAULT 'pending',
ALTER COLUMN "deliveryStatus" SET DEFAULT 'pending';

-- CreateIndex
CREATE UNIQUE INDEX "ProductionOrder_orderNumber_key" ON "ProductionOrder"("orderNumber");

-- AddForeignKey
ALTER TABLE "ProductionOrder" ADD CONSTRAINT "ProductionOrder_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
