-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "anticipoMonto" DOUBLE PRECISION,
ADD COLUMN     "notasCaso" TEXT,
ADD COLUMN     "tipoCaso" TEXT DEFAULT 'venta';
