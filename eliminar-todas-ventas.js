const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function eliminarTodasLasVentas() {
  try {
    console.log('🔍 Consultando ventas en la base de datos...\n');
    
    // Contar ventas antes de eliminar
    const count = await prisma.sale.count();
    
    console.log(`📊 Total de ventas encontradas: ${count}\n`);
    
    if (count === 0) {
      console.log('✅ No hay ventas en la base de datos');
      await prisma.$disconnect();
      return;
    }
    
    console.log('🗑️  Eliminando TODAS las ventas...\n');
    
    // Eliminar todas las ventas
    const resultado = await prisma.sale.deleteMany({});
    
    console.log(`✅ ${resultado.count} ventas eliminadas exitosamente\n`);
    console.log('🎉 Base de datos limpia y lista para empezar desde cero\n');
    
    await prisma.$disconnect();
    
  } catch (error) {
    console.error('❌ Error al eliminar ventas:', error.message);
    await prisma.$disconnect();
    process.exit(1);
  }
}

eliminarTodasLasVentas();