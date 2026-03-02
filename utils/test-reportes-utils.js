// ============================================
// SCRIPT DE TESTS: Funciones de Reportes
// ============================================
// Ejecutar con: node test-reportes-utils.js
// ============================================

const {
  categorizarProducto,
  determinarHojaDestino,
  calcularIVA,
  obtenerViernesDeLaSemana,
  formatearFecha,
  prepararDatosVentaParaReporte
} = require('./reportes-utils');

console.log('🧪 INICIANDO TESTS DE FUNCIONES DE REPORTES\n');

// ============================================
// TEST 1: Categorización de Productos
// ============================================
console.log('📦 TEST 1: Categorización de Productos');
console.log('='.repeat(50));

const testsCategorización = [
  { modelo: 'REGULADOR AUTOMÁTICO DE VOLTAJE INDUSTRIAL', expected: 'regulador' },
  { modelo: 'TRANSFORMADOR 220V-110V 5KVA', expected: 'transformador' },
  { modelo: 'SUPRESOR DE PICOS TRIFÁSICO', expected: 'supresor' },
  { modelo: 'VARIADOR DE FRECUENCIA 3HP', expected: 'variador' },
  { modelo: 'UPS 3KVA ONLINE', expected: 'ups' },
  { modelo: 'BATERÍA 12V 7AH', expected: 'ups' },
  { modelo: 'Mantenimiento preventivo regulador', expected: 'mantenimiento' },
  { modelo: 'Reparación de transformador', expected: 'mantenimiento' }
];

testsCategorización.forEach((test, idx) => {
  const resultado = categorizarProducto(test.modelo);
  const pass = resultado === test.expected;
  console.log(`  ${pass ? '✅' : '❌'} Test ${idx + 1}: "${test.modelo}"`);
  console.log(`     Esperado: ${test.expected}, Obtenido: ${resultado}`);
});

console.log();

// ============================================
// TEST 2: Determinación de Hoja Destino
// ============================================
console.log('📊 TEST 2: Determinación de Hoja Destino');
console.log('='.repeat(50));

const ventaRegulador = {
  items: [
    { modelo: 'REGULADOR 10KVA', descripcion: '' }
  ]
};

const ventaTransformador = {
  items: [
    { modelo: 'TRANSFORMADOR 5KVA', descripcion: '' }
  ]
};

const ventaMantenimiento = {
  items: [
    { modelo: 'Mantenimiento regulador', descripcion: '' }
  ]
};

const ventaMixta = {
  items: [
    { modelo: 'REGULADOR 10KVA', descripcion: '' },
    { modelo: 'TRANSFORMADOR 5KVA', descripcion: '' }
  ]
};

console.log('  📌 Venta de Regulador:');
console.log('    ', determinarHojaDestino(ventaRegulador));

console.log('  📌 Venta de Transformador:');
console.log('    ', determinarHojaDestino(ventaTransformador));

console.log('  📌 Venta de Mantenimiento:');
console.log('    ', determinarHojaDestino(ventaMantenimiento));

console.log('  📌 Venta Mixta (Regulador + Transformador):');
console.log('    ', determinarHojaDestino(ventaMixta));

console.log();

// ============================================
// TEST 3: Cálculo de IVA
// ============================================
console.log('💰 TEST 3: Cálculo de IVA');
console.log('='.repeat(50));

const testsIVA = [
  { monto: 11600, pais: 'MX', descripcion: 'Venta nacional $11,600' },
  { monto: 10000, pais: 'GT', descripcion: 'Venta Guatemala $10,000' },
  { monto: 23200, pais: 'MX', descripcion: 'Venta nacional $23,200' }
];

testsIVA.forEach(test => {
  const resultado = calcularIVA(test.monto, test.pais);
  console.log(`  📌 ${test.descripcion} (${test.pais}):`);
  console.log(`     Con IVA: $${resultado.conIVA.toFixed(2)}`);
  console.log(`     Sin IVA: $${resultado.sinIVA.toFixed(2)}`);
  console.log(`     IVA: $${resultado.montoIVA.toFixed(2)}`);
  console.log(`     Aplica IVA: ${resultado.aplicaIVA ? 'Sí' : 'No'}`);
  console.log();
});

// ============================================
// TEST 4: Cálculo de Viernes de la Semana
// ============================================
console.log('📅 TEST 4: Cálculo de Viernes de la Semana');
console.log('='.repeat(50));

const fechasPrueba = [
  new Date('2026-02-23'), // Lunes
  new Date('2026-02-25'), // Miércoles
  new Date('2026-02-27'), // Viernes
  new Date('2026-02-28'), // Sábado
  new Date('2026-03-01')  // Domingo
];

fechasPrueba.forEach(fecha => {
  const viernes = obtenerViernesDeLaSemana(fecha);
  const dias = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  console.log(`  📌 Entrada: ${formatearFecha(fecha)} (${dias[fecha.getDay()]})`);
  console.log(`     Viernes: ${formatearFecha(viernes)} (${dias[viernes.getDay()]})`);
});

console.log();

// ============================================
// TEST 5: Preparación de Datos para Reporte
// ============================================
console.log('📋 TEST 5: Preparación de Datos para Reporte');
console.log('='.repeat(50));

const ventaEjemplo = {
  id: 1,
  folio: 'COT-2026-001',
  date: new Date('2026-02-25'),
  total: 11600,
  country: 'MX',
  paymentType: 'anticipo',
  providerCost: 8000,
  client: { name: 'Grupo Regulador México' },
  createdBy: { name: 'Hugo' },
  createdById: 1,
  items: [
    {
      modelo: 'REGULADOR 10KVA ELECTROMECÁNICO',
      descripcion: 'Regulador automático de voltaje'
    }
  ]
};

const datosReporte = prepararDatosVentaParaReporte(ventaEjemplo);

console.log('  📌 Datos preparados:');
console.log(JSON.stringify(datosReporte, null, 2));

console.log();

// ============================================
// RESUMEN
// ============================================
console.log('🎯 TESTS COMPLETADOS');
console.log('='.repeat(50));
console.log('✅ Si todos los tests muestran resultados coherentes,');
console.log('   las funciones están listas para ser usadas.');
console.log();
console.log('📝 Siguiente paso: Aplicar migración del schema y insertar reglas de comisión.');