// utils/reportes-service.js (VERSIÓN CON COMISIONES POR TRAMOS)
// Servicio para generar reportes de ventas con comisiones por rangos acumulados

const { PrismaClient } = require('@prisma/client');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const {
  prepararDatosVentaParaReporte,
  calcularIVA
} = require('./reportes-utils');

const prisma = new PrismaClient();

// ============================================
// RANGOS DE COMISIÓN 2026
// ============================================
const RANGOS_COMISION = [
  { desde: 0, hasta: 690000, pctTotal: 0, pctHugo: 0, pctAuxiliar: 0 },
  { desde: 690001, hasta: 890000, pctTotal: 1.5, pctHugo: 1.0, pctAuxiliar: 0.5 },
  { desde: 890001, hasta: 1090000, pctTotal: 2.5, pctHugo: 1.5, pctAuxiliar: 1.0 },
  { desde: 1090001, hasta: 1290000, pctTotal: 3.5, pctHugo: 2.1, pctAuxiliar: 1.4 },
  { desde: 1290001, hasta: 2500000, pctTotal: 3.7, pctHugo: 2.22, pctAuxiliar: 1.48 },
  { desde: 2500001, hasta: Infinity, pctTotal: 3.7, pctHugo: 2.22, pctAuxiliar: 1.48 }
];

/**
 * Calcula comisiones por tramos acumulados
 * @param {number} montoAcumulado - Total vendido hasta el momento
 * @param {number} montoVenta - Monto de la venta actual
 * @param {string} rol - 'hugo' o 'auxiliar'
 * @returns {object} { porcentaje, comision }
 */
function calcularComisionPorTramos(montoAcumulado, montoVenta, rol = 'hugo') {
  const totalDespuesVenta = montoAcumulado + montoVenta;
  let comisionTotal = 0;
  let porcentajePromedio = 0;

  // Calcular comisión por cada tramo que toca esta venta
  for (const rango of RANGOS_COMISION) {
    // ¿Esta venta toca este rango?
    if (totalDespuesVenta > rango.desde) {
      // Calcular cuánto de la venta cae en este tramo
      const inicioTramo = Math.max(montoAcumulado, rango.desde);
      const finTramo = Math.min(totalDespuesVenta, rango.hasta);
      const montoEnTramo = Math.max(0, finTramo - inicioTramo);

      if (montoEnTramo > 0) {
        const pct = rol === 'hugo' ? rango.pctHugo : rango.pctAuxiliar;
        const comisionTramo = (montoEnTramo * pct) / 100;
        comisionTotal += comisionTramo;

        console.log(`    💰 Tramo $${inicioTramo.toLocaleString()} - $${finTramo.toLocaleString()}: ${pct}% sobre $${montoEnTramo.toLocaleString()} = $${comisionTramo.toFixed(2)}`);
      }
    }
  }

  // Calcular porcentaje promedio para esta venta
  porcentajePromedio = montoVenta > 0 ? (comisionTotal / montoVenta) * 100 : 0;

  return {
    porcentaje: porcentajePromedio,
    comision: comisionTotal
  };
}

/**
 * Genera un reporte de ventas ANUAL en Excel
 * @param {number} año - Año
 * @param {number} userId - ID del usuario que genera el reporte
 * @returns {Promise<string>} - Ruta del archivo Excel generado
 */
async function generarReporteAnual(año, userId) {
  console.log(`📊 Generando reporte de ventas ANUAL: ${año}`);

  try {
    // 1. Obtener TODAS las ventas del año
    const inicioAño = new Date(año, 0, 1);
    const finAño = new Date(año + 1, 0, 1);

    const todasLasVentas = await prisma.sale.findMany({
      where: {
        date: {
          gte: inicioAño,
          lt: finAño
        },
        status: {
          not: 'cancelada'
        },
        deletedAt: null
      },
      include: {
        client: true,
        items: true,
        createdBy: true
      },
      orderBy: {
        date: 'asc'
      }
    });

    console.log(`  📊 Total de ventas encontradas en ${año}: ${todasLasVentas.length}`);

    // Filtrar ventas SIN usuario asignado
    const ventasSinUsuario = todasLasVentas.filter(v => !v.createdBy || !v.createdById);
    const ventasConUsuario = todasLasVentas.filter(v => v.createdBy && v.createdById);

    if (ventasSinUsuario.length > 0) {
      console.log(`  ⚠️  ${ventasSinUsuario.length} ventas SIN usuario asignado (se excluirán del reporte)`);
    }

    console.log(`  ✅ ${ventasConUsuario.length} ventas CON usuario asignado (se incluirán)`);

    if (ventasConUsuario.length === 0) {
      throw new Error('No hay ventas con usuario asignado en el año seleccionado');
    }

    // 2. Preparar datos agrupados por mes
    const datosReporte = {
      general: [],
      comisiones: [],
      comercializacion: []
    };

    // Acumulados por vendedor (se mantienen durante todo el año)
    const acumuladosPorVendedor = {};

    for (const venta of ventasConUsuario) {
      // Preparar datos básicos
      const datosVenta = prepararDatosVentaParaReporte(venta);
      const vendedor = datosVenta.vendedor;
      
      // 👇 AGREGAR ESTO TEMPORALMENTE
      console.log(`  🔍 Venta ${venta.folio} - tipoCaso en BD: "${venta.tipoCaso}"`);
      console.log(`  🔍 Venta ${venta.folio} - country: "${venta.country}"`);
      console.log(`  🔍 Venta ${venta.folio}`);
      console.log(`       tipoCaso: "${venta.tipoCaso}"`);
      console.log(`       netMxn: ${venta.netMxn}`);
      console.log(`       total: ${venta.total}`);
      console.log(`       reparacionMonto: ${venta.reparacionMonto}`);
      console.log(`       mantenimientoMonto: ${venta.mantenimientoMonto}`);
      console.log(`       anticipoMonto: ${venta.anticipoMonto}`);

      // ⭐ USAR MONTO SEGÚN TIPO DE CASO
      const tipoCaso = venta.tipoCaso || 'venta';

    let montoBase;
      if (tipoCaso === 'reparacion' && venta.reparacionMonto) {
        montoBase = venta.reparacionMonto;
      } else if (tipoCaso === 'mantenimiento' && venta.mantenimientoMonto) {
        montoBase = venta.mantenimientoMonto;
      } else if (tipoCaso === 'anticipo' && venta.anticipoMonto) {
        montoBase = venta.anticipoMonto;
      } else if (tipoCaso === 'saldo') {
        montoBase = venta.netMxn || venta.total;
      } else {
        montoBase = venta.netMxn || venta.total;
      }

      // ⭐ Saldos, reparaciones y mantenimientos ya vienen en MXN directo — no convertir
      let montoMXN, sinIvaMXN;
      if (tipoCaso === 'saldo' || tipoCaso === 'reparacion' || tipoCaso === 'mantenimiento') {
        montoMXN = montoBase;
        sinIvaMXN = montoBase / 1.16;
      } else {
        // Ventas normales y anticipos: respetar país (IVA y moneda)
        const ivaCalc = calcularIVA(montoBase, venta.country || 'MX');
        montoMXN = ivaCalc.conIVA;
        sinIvaMXN = ivaCalc.sinIVA;
      }
      console.log(`💰 MONTO DEBUG folio=${venta.folio} tipoCaso=${tipoCaso} montoBase=${montoBase} montoMXN=${montoMXN} sinIvaMXN=${sinIvaMXN} netMxn=${venta.netMxn} total=${venta.total} currency=${venta.currency} exchangeRate=${venta.exchangeRate}`);
      
      // ⭐ CONSTRUIR CONCEPTO ESTRUCTURADO desde los items
      // ⭐ PREFIJO SEGÚN TIPO DE CASO
      const PREFIJOS_CASO = {
        'reparacion':    'Reparación',
        'mantenimiento': 'Mantenimiento',
        'anticipo':      'Anticipo',
        'saldo':         'Saldo',
        'venta':         null
      };

      const PREFIJOS_CATEGORIA = {
        'regulador_electronico': 'Regulador Electrónico',
        'equipo_ec':             'Equipo de EC',
        'ups':                   'UPS',
        'planta':                'Planta',
        'transformador':         'Transformador',
        'instalacion':           'Instalación',
        'supresor':              'Supresor de Picos',
        'variador':              'Variador de Voltaje'
      };

// ⭐ FUNCIÓN: construir concepto de un item individual
      function buildItemConcepto(item) {
        const partes = [];
        if (item.modelo) partes.push(item.modelo.trim());
        if (item.descripcion) {
          const desc = item.descripcion;
          const capacidadMatch = desc.match(/(\d+\.?\d*)\s*(kva|kw|va|w)/i);
          if (capacidadMatch) partes.push(capacidadMatch[0].toUpperCase());
          if (desc.match(/monof[áa]sic[oa]|1\s*f|1f/i)) partes.push('Monofásico');
          else if (desc.match(/trif[áa]sic[oa]|3\s*f|3f/i)) partes.push('Trifásico');
          else if (desc.match(/bif[áa]sic[oa]|2\s*f|2f/i)) partes.push('Bifásico');
          const voltajeMatch = desc.match(/(\d+\s*\/?\\s*\d*)\s*v(?:oltios?)?/i);
          if (voltajeMatch) partes.push(voltajeMatch[1].trim() + ' V');
        }
        const conceptoBase = partes.length > 0 ? partes.join(' - ') : item.modelo || '';

        // Prefijo de producto por item
        let prefijoProducto = null;
        if (item.categoryType) {
          prefijoProducto = PREFIJOS_CATEGORIA[item.categoryType] || null;
        }
        if (!prefijoProducto && item.modelo?.trim().toUpperCase().startsWith('RM')) {
          prefijoProducto = 'Regulador';
        }
        return prefijoProducto ? `${prefijoProducto} - ${conceptoBase}` : conceptoBase;
      }

      // ⭐ CONSTRUIR CONCEPTO ESTRUCTURADO (todos los items combinados)
      let conceptoEstructurado = '';
      if (venta.items && venta.items.length > 0) {
        const prefijoCaso = PREFIJOS_CASO[tipoCaso];
        const conceptosTodos = venta.items.map(item => buildItemConcepto(item));
        const conceptoCombinado = conceptosTodos.join(' + ');
        conceptoEstructurado = prefijoCaso
          ? `${prefijoCaso} - ${conceptoCombinado}`
          : conceptoCombinado;
      } else {
        conceptoEstructurado = datosVenta.concepto;
      }

      // Inicializar acumulado si no existe
      if (!acumuladosPorVendedor[vendedor]) {
        acumuladosPorVendedor[vendedor] = {
          totalVendido: 0,
          totalComisionHugo: 0,
          totalComisionAuxiliar: 0
        };
      }

      // Agregar a GENERAL (todas las ventas)
      datosReporte.general.push({
        mes: venta.date.getMonth() + 1, // ⭐ AGREGAR MES
        fecha: datosVenta.fecha,
        cliente: datosVenta.cliente,
        empresa: venta.client?.company || '',
        concepto: conceptoEstructurado,
        amountWithIVA: montoMXN,           // ⭐ USAR MONTO EN MXN
        amountWithoutIVA: sinIvaMXN,       // ⭐ USAR SIN IVA EN MXN
        total: montoMXN,                   // ⭐ USAR MONTO EN MXN
        week: datosVenta.semanaViernes,
        vendor: vendedor,
        paymentType: datosVenta.tipoPago,
        country: venta.country || 'MX'   // ⭐ NUEVO
      });

      // Agregar a COMISIONES (reguladores + mantenimientos)
      if (datosVenta.vaAComisiones) {
      // ⭐ Calcular monto proporcional solo de items que van a comisiones
        const itemsParaComisiones = datosVenta.itemsRegulador?.length
          ? datosVenta.itemsRegulador
          : venta.items;
        // ⭐ Convertir subtotales a MXN para calcular proporción correctamente
        const exchangeRate = venta.exchangeRate || 1;
        const subtotalParaComisionesMXN = itemsParaComisiones.reduce((sum, i) => sum + ((i.subtotal || 0) * exchangeRate), 0);
        const subtotalTotalMXN = venta.items.reduce((sum, i) => sum + ((i.subtotal || 0) * exchangeRate), 0);
        const proporcionComisiones = subtotalTotalMXN > 0 ? subtotalParaComisionesMXN / subtotalTotalMXN : 1;
        const montoMXNComisiones = montoMXN * proporcionComisiones;
        const sinIvaMXNComisiones = sinIvaMXN * proporcionComisiones;

        const montoVenta = sinIvaMXNComisiones;
        const acumuladoAnterior = acumuladosPorVendedor[vendedor].totalVendido;

        const comisionHugo = calcularComisionPorTramos(acumuladoAnterior, montoVenta, 'hugo');
        const comisionAuxiliar = calcularComisionPorTramos(acumuladoAnterior, montoVenta, 'auxiliar');

        acumuladosPorVendedor[vendedor].totalVendido += montoVenta;
        acumuladosPorVendedor[vendedor].totalComisionHugo += comisionHugo.comision;
        acumuladosPorVendedor[vendedor].totalComisionAuxiliar += comisionAuxiliar.comision;

        // ⭐ Concepto solo con items que NO son comercialización
        const itemsNoComercializ = datosVenta.itemsRegulador?.length
          ? datosVenta.itemsRegulador
          : venta.items;
        const conceptoComisiones = (() => {
          const prefijoCaso = PREFIJOS_CASO[tipoCaso];
          const conceptosTodos = itemsNoComercializ.map(item => buildItemConcepto(item));
          const combinado = conceptosTodos.join(' + ');
          return prefijoCaso ? `${prefijoCaso} - ${combinado}` : combinado;
        })();

        datosReporte.comisiones.push({
          mes: venta.date.getMonth() + 1,
          fecha: datosVenta.fecha,
          cliente: datosVenta.cliente,
          empresa: venta.client?.company || '',
          concepto: conceptoComisiones,
          amountWithIVA: montoMXNComisiones,
          amountWithoutIVA: sinIvaMXNComisiones,
          total: montoMXNComisiones,
          week: datosVenta.semanaViernes,
          vendor: vendedor,
          commissionPct: comisionHugo.porcentaje,
          commissionHugo: comisionHugo.comision,
          commissionAux: comisionAuxiliar.comision,
          country: venta.country || 'MX'
        });
      }

// Agregar a COMERCIALIZACIÓN — una fila por cada item de comercialización
      if (datosVenta.vaAComercializacion) {
        const itemsComercializ = datosVenta.itemsComercializacion?.length
          ? datosVenta.itemsComercializacion
          : venta.items;

        for (const itemCom of itemsComercializ) {
          const conceptoItem = buildItemConcepto(itemCom);
          const conceptoComercializ = PREFIJOS_CASO[tipoCaso]
            ? `${PREFIJOS_CASO[tipoCaso]} - ${conceptoItem}`
            : conceptoItem;

          // ⭐ Para saldos, calcular proporción entre items (no contra venta.total que está en MXN)
          const exchRate = venta.exchangeRate || 1;
          // ⭐ Proporción del item vs TODOS los items (no solo comercialización)
          const totalSubtotalTodosMXN = venta.items.reduce((sum, i) => sum + ((i.subtotal || 0) * exchRate), 0);
          const proporcion = totalSubtotalTodosMXN > 0 ? ((itemCom.subtotal * exchRate) / totalSubtotalTodosMXN) : (1 / itemsComercializ.length);
          const montoItemMXN = montoMXN * proporcion;
          const sinIvaItemMXN = sinIvaMXN * proporcion;
          const providerCostItem = itemCom.providerCost || 0;
          const utilidadItem = sinIvaItemMXN - (providerCostItem / 1.16);
          const comision = utilidadItem *
            (vendedor.toLowerCase().includes('hugo') ? 0.05 : 0.10);

          datosReporte.comercializacion.push({
            mes: venta.date.getMonth() + 1,
            fecha: datosVenta.fecha,
            cliente: datosVenta.cliente,
            empresa: venta.client?.company || '',
            concepto: conceptoComercializ,
            amountWithIVA: montoItemMXN,
            amountWithoutIVA: sinIvaItemMXN,
            providerCostWithIVA: providerCostItem,
            providerCost: providerCostItem / 1.16,
            vendor: vendedor,
            commission: comision,
            country: venta.country || 'MX'
          });
}
      }
    } // cierra for (const venta of ventasConUsuario)
      
    console.log(`\n  📊 RESUMEN POR MES:`);
    for (let mes = 1; mes <= 12; mes++) {
      const ventasMes = datosReporte.general.filter(v => v.mes === mes);
      if (ventasMes.length > 0) {
        const meses = ['', 'ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO',
                       'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];
        console.log(`     ${meses[mes]}: ${ventasMes.length} ventas`);
      }
    }

    console.log(`\n  📋 Totales:`);
    console.log(`     - GENERAL: ${datosReporte.general.length} ventas`);
    console.log(`     - COMISIONES: ${datosReporte.comisiones.length} ventas`);
    console.log(`     - COMERCIALIZACIÓN: ${datosReporte.comercializacion.length} ventas`);

    // 3. Generar nombre de archivo
    const timestamp = Date.now();
    const nombreArchivo = `REPORTE_VENTAS_${año}_${timestamp}.xlsx`;
    const outputPath = path.resolve(__dirname, '..', 'temp', 'reports', nombreArchivo);

    const dirReports = path.dirname(outputPath);
    if (!fs.existsSync(dirReports)) {
      fs.mkdirSync(dirReports, { recursive: true });
    }

    // 4. Llamar al script Python (SIN mes, solo año)
    const pythonScript = path.resolve(__dirname, '..', 'scripts', 'generate-sales-report.py');
    const dataJson = JSON.stringify(datosReporte);

    console.log(`  📋 Primer concepto GENERAL: ${datosReporte.general[0]?.concepto}`);
    console.log(`  📋 Primer concepto COMISIONES: ${datosReporte.comisiones[0]?.concepto}`);
    console.log(`  🐍 Ejecutando script Python...`);
    await ejecutarScriptPython(pythonScript, dataJson, outputPath, año);

    console.log(`  ✅ Excel generado correctamente`);

    // 5. Registrar reporte en la BD
    await prisma.salesReport.create({
      data: {
        reportType: 'annual',
        year: año,
        filePath: outputPath,
        generatedById: userId,
        metadata: {
          totalVentasEncontradas: todasLasVentas.length,
          ventasSinUsuario: ventasSinUsuario.length,
          ventasIncluidas: ventasConUsuario.length,
          totalGeneral: datosReporte.general.length,
          totalComisiones: datosReporte.comisiones.length,
          totalComercializacion: datosReporte.comercializacion.length,
          acumuladosPorVendedor
        }
      }
    });

    console.log(`  💾 Reporte registrado en BD`);

    return outputPath;

  } catch (error) {
    console.error('❌ Error generando reporte:', error);
    throw error;
  }
}
function ejecutarScriptPython(scriptPath, dataJson, outputPath, año) {
  return new Promise((resolve, reject) => {
    const tempDir = path.dirname(outputPath);
    const tempJsonPath = path.join(tempDir, `data_${Date.now()}.json`);
    
    try {
      fs.writeFileSync(tempJsonPath, dataJson, 'utf8');
      console.log(`  💾 JSON guardado en: ${tempJsonPath}`);
    } catch (error) {
      return reject(new Error(`Error guardando archivo temporal: ${error.message}`));
    }
    
    // ⭐ SOLO PASAR AÑO (sin mes)
    const pythonProcess = spawn('python3', [
      `"${scriptPath}"`,
      `"${tempJsonPath}"`,
      `"${outputPath}"`,
      año.toString()
    ], {
      shell: true,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    pythonProcess.stdout.on('data', (data) => {
      stdout += data.toString();
      console.log(`  [Python] ${data.toString().trim()}`);
    });

    pythonProcess.stderr.on('data', (data) => {
      stderr += data.toString();
      console.error(`  [Python Error] ${data.toString().trim()}`);
    });

    pythonProcess.on('close', (code) => {
      try {
        if (fs.existsSync(tempJsonPath)) {
          fs.unlinkSync(tempJsonPath);
          console.log(`  🗑️  Archivo temporal eliminado`);
        }
      } catch (error) {
        console.warn(`  ⚠️  No se pudo eliminar archivo temporal: ${error.message}`);
      }
      
      if (code !== 0) {
        reject(new Error(`Script Python falló con código ${code}\n${stderr}`));
      } else {
        resolve(stdout);
      }
    });

    pythonProcess.on('error', (error) => {
      try {
        if (fs.existsSync(tempJsonPath)) {
          fs.unlinkSync(tempJsonPath);
        }
      } catch (e) {}
      
      reject(new Error(`Error ejecutando Python: ${error.message}`));
    });
  });
}

/**
 * Obtiene la lista de reportes generados
 */
async function obtenerReportes(filters = {}) {
  const where = {};

  if (filters.year) where.year = parseInt(filters.year);
  if (filters.month) where.month = parseInt(filters.month);
  if (filters.reportType) where.reportType = filters.reportType;

  const reportes = await prisma.salesReport.findMany({
    where,
    include: {
      generatedBy: {
        select: {
          id: true,
          name: true,
          email: true
        }
      }
    },
    orderBy: {
      createdAt: 'desc'
    }
  });

  return reportes;
}

module.exports = {
  generarReporteAnual,
  obtenerReportes
};