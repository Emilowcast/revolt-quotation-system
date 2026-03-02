// test-reporte-anual.js
// Genera reporte ANUAL con TODOS los meses de 2026

const { generarReporteAnual } = require('./utils/reportes-service');

async function testAnual() {
  console.log('🧪 GENERANDO REPORTE ANUAL 2026...\n');
  
  try {
    const año = 2026;
    const userId = 1;
    
    const filePath = await generarReporteAnual(año, userId);
    
    console.log('\n✅ REPORTE ANUAL GENERADO:');
    console.log(`📁 Archivo: ${filePath}`);
    console.log('\n📊 El Excel incluye:');
    console.log('  - TODOS los meses del año 2026');
    console.log('  - Hoja GENERAL con todas las ventas');
    console.log('  - Hoja Comisiones con reguladores');
    console.log('  - Hoja Comercializacion con otros productos');
    
  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    console.error(error.stack);
  }
  
  process.exit(0);
}

testAnual();