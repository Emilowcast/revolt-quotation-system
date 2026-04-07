-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "anticipoMonto" DOUBLE PRECISION,
ADD COLUMN     "mantenimientoMonto" DOUBLE PRECISION,
ADD COLUMN     "notasCaso" TEXT,
ADD COLUMN     "reparacionMonto" DOUBLE PRECISION,
ADD COLUMN     "tipoCaso" TEXT DEFAULT 'venta';
