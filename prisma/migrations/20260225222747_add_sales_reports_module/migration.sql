-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "category" TEXT;

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "categoryType" TEXT,
ADD COLUMN     "country" TEXT DEFAULT 'MX',
ADD COLUMN     "hasIVA" BOOLEAN DEFAULT true,
ADD COLUMN     "isService" BOOLEAN DEFAULT false,
ADD COLUMN     "paymentType" TEXT,
ADD COLUMN     "providerCost" DOUBLE PRECISION,
ADD COLUMN     "weekEndDate" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CommissionRule" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "rangeMin" DOUBLE PRECISION NOT NULL,
    "rangeMax" DOUBLE PRECISION,
    "percentageTotal" DOUBLE PRECISION NOT NULL,
    "percentageHugo" DOUBLE PRECISION NOT NULL,
    "percentageAux" DOUBLE PRECISION NOT NULL,
    "productType" TEXT,
    "month" INTEGER,
    "year" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Commission" (
    "id" SERIAL NOT NULL,
    "saleId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "vendorRole" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "productType" TEXT NOT NULL,
    "baseAmount" DOUBLE PRECISION NOT NULL,
    "rangeApplied" TEXT NOT NULL,
    "percentage" DOUBLE PRECISION NOT NULL,
    "commissionAmount" DOUBLE PRECISION NOT NULL,
    "monthlyAccumulated" DOUBLE PRECISION NOT NULL,
    "isPaid" BOOLEAN NOT NULL DEFAULT false,
    "paidAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Commission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesReport" (
    "id" SERIAL NOT NULL,
    "reportType" TEXT NOT NULL,
    "month" INTEGER,
    "year" INTEGER NOT NULL,
    "quarter" INTEGER,
    "filePath" TEXT NOT NULL,
    "generatedById" INTEGER NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommissionRule_rangeMin_rangeMax_idx" ON "CommissionRule"("rangeMin", "rangeMax");

-- CreateIndex
CREATE INDEX "CommissionRule_year_month_idx" ON "CommissionRule"("year", "month");

-- CreateIndex
CREATE INDEX "Commission_userId_month_year_idx" ON "Commission"("userId", "month", "year");

-- CreateIndex
CREATE INDEX "Commission_saleId_idx" ON "Commission"("saleId");

-- CreateIndex
CREATE INDEX "Commission_month_year_idx" ON "Commission"("month", "year");

-- CreateIndex
CREATE INDEX "SalesReport_year_month_idx" ON "SalesReport"("year", "month");

-- CreateIndex
CREATE INDEX "SalesReport_reportType_idx" ON "SalesReport"("reportType");

-- AddForeignKey
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesReport" ADD CONSTRAINT "SalesReport_generatedById_fkey" FOREIGN KEY ("generatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
