// ============================================
// MÓDULO: utils/reportes-utils.js
// Descripción: Funciones utilitarias para el módulo de reportes de ventas
// ============================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ============================================
// CONSTANTES
// ============================================

const IVA_FACTOR = 1.16;

const CATEGORIAS_PRODUCTOS = {
  REGULADOR: 'regulador',
  TRANSFORMADOR: 'transformador',
  SUPRESOR: 'supresor',
  VARIADOR: 'variador',
  UPS: 'ups',
  MANTENIMIENTO: 'mantenimiento'
};

const HOJA_DESTINO = {
  GENERAL: 'general',
  COMISIONES: 'comisiones',
  COMERCIALIZACION: 'comercializacion'
};

// ============================================
// FUNCIONES DE CATEGORIZACIÓN
// ============================================

/**
 * Categoriza un producto basado en su modelo y descripción
 * @param {string} modelo - Modelo del producto
 * @param {string} descripcion - Descripción del producto
 * @returns {string} - Categoría del producto
 */
function categorizarProducto(modelo, descripcion = '') {
  const texto = `${modelo} ${descripcion}`.toLowerCase();
  
  // Detectar mantenimientos y reparaciones
  if (texto.includes('mantenimiento') || texto.includes('reparación') || texto.includes('reparacion')) {
    return CATEGORIAS_PRODUCTOS.MANTENIMIENTO;
  }
  
  // Detectar reguladores
  if (texto.includes('regulador')) {
    return CATEGORIAS_PRODUCTOS.REGULADOR;
  }
  
  // Detectar transformadores
  if (texto.includes('transformador')) {
    return CATEGORIAS_PRODUCTOS.TRANSFORMADOR;
  }
  
  // Detectar supresores de picos
  if (texto.includes('supresor') || texto.includes('picos')) {
    return CATEGORIAS_PRODUCTOS.SUPRESOR;
  }
  
  // Detectar variadores
  if (texto.includes('variador')) {
    return CATEGORIAS_PRODUCTOS.VARIADOR;
  }
  
  // Detectar UPS y baterías
  if (texto.includes('ups') || texto.includes('batería') || texto.includes('bateria') || 
      texto.includes('sistema de energía interrumpida')) {
    return CATEGORIAS_PRODUCTOS.UPS;
  }
  
  // Por defecto, si no se identifica
  return 'otro';
}

/**
 * Determina en qué hoja(s) del reporte debe aparecer una venta
 * @param {object} sale - Objeto de venta con items
 * @returns {object} - {general: true, comisiones: boolean, comercializacion: boolean}
 */
const CATEGORIAS_COMERCIALIZACION = [
  'regulador_electronico', 'equipo_ec', 'ups', 'planta',
  'transformador', 'instalacion', 'supresor', 'variador',
  'multimetro', 'garantia'
];

function determinarHojaDestino(sale) {
  const esReparacionOMantenimiento = sale.tipoCaso === 'reparacion' ||
                                     sale.tipoCaso === 'mantenimiento';

  // ⭐ Revisar categoryType por item (nuevo sistema)
  if (sale.items && sale.items.some(item => item.categoryType)) {
    const tieneComercializacion = sale.items.some(item =>
      CATEGORIAS_COMERCIALIZACION.includes(item.categoryType)
    );
      const tieneRegulador = sale.items.some(item =>
      !CATEGORIAS_COMERCIALIZACION.includes(item.categoryType) &&
      item.modelo?.trim().toUpperCase().startsWith('RM')
    );

    return {
      general: true,
      comisiones: tieneRegulador || esReparacionOMantenimiento,
      comercializacion: tieneComercializacion,
      // ⭐ Items separados para el reporte
      itemsComercializacion: sale.items.filter(item =>
        CATEGORIAS_COMERCIALIZACION.includes(item.categoryType)
      ),
      itemsRegulador: sale.items.filter(item =>
        !item.categoryType || !CATEGORIAS_COMERCIALIZACION.includes(item.categoryType)
      )
    };
  }

  // ⭐ Fallback: detección por texto (ventas antiguas sin categoryType por item)
  const categorias = sale.items.map(item =>
    categorizarProducto(item.modelo, item.descripcion)
  );

  const tieneRegulador     = categorias.includes(CATEGORIAS_PRODUCTOS.REGULADOR);
  const tieneMantenimiento = categorias.includes(CATEGORIAS_PRODUCTOS.MANTENIMIENTO);
  const tieneOtrosProductos = categorias.some(cat =>
    cat === CATEGORIAS_PRODUCTOS.TRANSFORMADOR ||
    cat === CATEGORIAS_PRODUCTOS.SUPRESOR ||
    cat === CATEGORIAS_PRODUCTOS.UPS
  );

  return {
    general: true,
    comisiones: tieneRegulador || tieneMantenimiento || esReparacionOMantenimiento,
    comercializacion: tieneOtrosProductos,
    itemsComercializacion: sale.items.filter(item =>
      CATEGORIAS_COMERCIALIZACION.includes(
        categorizarProducto(item.modelo, item.descripcion)
      )
    ),
    itemsRegulador: sale.items.filter(item =>
      !CATEGORIAS_COMERCIALIZACION.includes(
        categorizarProducto(item.modelo, item.descripcion)
      )
    )
  };
}

/**
 * Detecta si una venta es un servicio (mantenimiento/reparación)
 * @param {object} sale - Objeto de venta
 * @returns {boolean}
 */
function esServicio(sale) {
  return sale.items.some(item => {
    const categoria = categorizarProducto(item.modelo, item.descripcion);
    return categoria === CATEGORIAS_PRODUCTOS.MANTENIMIENTO;
  });
}

// ============================================
// FUNCIONES DE CÁLCULO DE IVA
// ============================================

/**
 * Calcula montos con y sin IVA
 * @param {number} montoConIVA - Monto con IVA incluido
 * @param {string} pais - Código del país (MX, GT, SV, PA, etc.)
 * @returns {object} - {conIVA, sinIVA, montoIVA, aplicaIVA}
 */
function calcularIVA(montoConIVA, pais = 'MX') {
  // Lista de países exentos de IVA
  const paisesExentos = ['GT', 'SV', 'PA', 'HN', 'NI', 'CR'];
  
  const aplicaIVA = !paisesExentos.includes(pais.toUpperCase());
  
  if (!aplicaIVA) {
    // Ventas internacionales: el monto ya viene sin IVA
    return {
      conIVA: montoConIVA,
      sinIVA: montoConIVA,
      montoIVA: 0,
      aplicaIVA: false
    };
  }
  
  // Ventas nacionales: calcular sin IVA
  const sinIVA = montoConIVA / IVA_FACTOR;
  const montoIVA = montoConIVA - sinIVA;
  
  return {
    conIVA: montoConIVA,
    sinIVA: sinIVA,
    montoIVA: montoIVA,
    aplicaIVA: true
  };
}

/**
 * Obtiene el factor de IVA configurable
 * @returns {number} - Factor de IVA (por defecto 1.16)
 */
function getIVAFactor() {
  // TODO: Hacer esto configurable desde la base de datos
  return IVA_FACTOR;
}

// ============================================
// FUNCIONES DE FECHAS
// ============================================

/**
 * Obtiene la fecha del viernes de la semana de una fecha dada
 * @param {Date} fecha - Fecha de referencia
 * @returns {Date} - Fecha del viernes de esa semana
 */
function obtenerViernesDeLaSemana(fecha) {
  const d = new Date(fecha);
  const diaSemana = d.getDay(); // 0=domingo, 5=viernes
  
  // Calcular días hasta el viernes
  let diasHastaViernes = (5 - diaSemana + 7) % 7;
  
  // Si ya es viernes, no cambiar
  if (diaSemana === 5) {
    diasHastaViernes = 0;
  }
  // Si es sábado o domingo, ir al viernes de la semana siguiente
  else if (diaSemana === 6 || diaSemana === 0) {
    diasHastaViernes = (5 - diaSemana + 7) % 7;
  }
  
  d.setDate(d.getDate() + diasHastaViernes);
  
  // Establecer hora a medianoche
  d.setHours(0, 0, 0, 0);
  
  return d;
}

/**
 * Obtiene el número de semana del año
 * @param {Date} fecha - Fecha de referencia
 * @returns {number} - Número de semana (1-52/53)
 */
function obtenerNumeroSemana(fecha) {
  const d = new Date(fecha);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return weekNo;
}

/**
 * Formatea fecha al formato dd/mm/yyyy
 * @param {Date} fecha - Fecha a formatear
 * @returns {string} - Fecha formateada
 */
function formatearFecha(fecha) {
  const d = new Date(fecha);
  const dia = String(d.getDate()).padStart(2, '0');
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const año = d.getFullYear();
  return `${dia}/${mes}/${año}`;
}

// ============================================
// FUNCIONES DE CÁLCULO DE COMISIONES
// ============================================

/**
 * Obtiene el total acumulado de ventas del mes para un vendedor
 * @param {number} userId - ID del vendedor
 * @param {number} mes - Mes (1-12)
 * @param {number} año - Año
 * @returns {number} - Total acumulado
 */
async function obtenerAcumuladoMensual(userId, mes, año) {
  const inicioMes = new Date(año, mes - 1, 1);
  const finMes = new Date(año, mes, 1);
  
  const resultado = await prisma.sale.aggregate({
    where: {
      createdById: userId,
      date: {
        gte: inicioMes,
        lt: finMes
      },
      status: {
        not: 'cancelada'
      }
    },
    _sum: {
      netMxn: true
    }
  });
  
  return resultado._sum.netMxn || 0;
}

/**
 * Encuentra la regla de comisión aplicable según el monto acumulado
 * @param {number} montoAcumulado - Monto acumulado del mes
 * @param {number} año - Año
 * @param {string} tipoProducto - Tipo de producto (opcional)
 * @returns {object|null} - Regla de comisión aplicable
 */
async function encontrarReglaComision(montoAcumulado, año, tipoProducto = null) {
  const reglas = await prisma.commissionRule.findMany({
    where: {
      year: año,
      active: true,
      OR: [
        { productType: tipoProducto },
        { productType: null }
      ]
    },
    orderBy: {
      rangeMin: 'asc'
    }
  });
  
  // Encontrar la regla que aplica
  for (const regla of reglas) {
    const dentroDelRango = montoAcumulado >= regla.rangeMin &&
      (regla.rangeMax === null || montoAcumulado <= regla.rangeMax);
    
    if (dentroDelRango) {
      return regla;
    }
  }
  
  return null;
}

/**
 * Calcula la comisión para una venta específica
 * @param {object} sale - Objeto de venta
 * @param {object} user - Usuario vendedor
 * @param {string} rolVendedor - 'hugo' o 'auxiliar'
 * @returns {object} - {comisionCalculada, reglaAplicada, acumuladoMes}
 */
async function calcularComisionVenta(sale, user, rolVendedor = 'hugo') {
  const mes = sale.date.getMonth() + 1;
  const año = sale.date.getFullYear();
  
  // 1. Obtener acumulado mensual ANTES de esta venta
  let acumuladoMes = await obtenerAcumuladoMensual(user.id, mes, año);
  
  // 2. Agregar esta venta al acumulado
  const ivaCalc = calcularIVA(sale.total, sale.country);
  acumuladoMes += ivaCalc.sinIVA;
  
  // 3. Encontrar regla aplicable
  const regla = await encontrarReglaComision(acumuladoMes, año);
  
  if (!regla) {
    return {
      comisionCalculada: 0,
      reglaAplicada: 'Sin regla aplicable',
      acumuladoMes: acumuladoMes,
      porcentajeAplicado: 0
    };
  }
  
  // 4. Calcular comisión según el rol
  const porcentaje = rolVendedor === 'hugo' 
    ? regla.percentageHugo 
    : regla.percentageAux;
  
  // 5. Base de cálculo
  let baseCalculo = ivaCalc.sinIVA;
  
  // Para comercialización, usar utilidad si hay costo de proveedor
  const categoriaVenta = determinarHojaDestino(sale);
  if (categoriaVenta.comercializacion && sale.providerCost) {
    baseCalculo = ivaCalc.sinIVA - sale.providerCost;
  }
  
  const comisionCalculada = baseCalculo * porcentaje;
  
  return {
    comisionCalculada: comisionCalculada,
    reglaAplicada: regla.name,
    acumuladoMes: acumuladoMes,
    porcentajeAplicado: porcentaje,
    baseCalculo: baseCalculo
  };
}

/**
 * Crea registro de comisión en la base de datos
 * @param {object} sale - Venta
 * @param {object} user - Usuario
 * @param {string} rolVendedor - 'hugo' o 'auxiliar'
 * @param {object} calculoComision - Resultado de calcularComisionVenta
 */
async function registrarComision(sale, user, rolVendedor, calculoComision) {
  const mes = sale.date.getMonth() + 1;
  const año = sale.date.getFullYear();
  
  const categorias = sale.items.map(item => 
    categorizarProducto(item.modelo, item.descripcion)
  );
  const tipoProducto = categorias[0] || 'otro';
  
  await prisma.commission.create({
    data: {
      saleId: sale.id,
      userId: user.id,
      vendorRole: rolVendedor,
      month: mes,
      year: año,
      productType: tipoProducto,
      baseAmount: calculoComision.baseCalculo,
      rangeApplied: calculoComision.reglaAplicada,
      percentage: calculoComision.porcentajeAplicado,
      commissionAmount: calculoComision.comisionCalculada,
      monthlyAccumulated: calculoComision.acumuladoMes
    }
  });
}

// ============================================
// FUNCIONES DE PREPARACIÓN DE DATOS
// ============================================

/**
 * Prepara datos de una venta para el reporte
 * @param {object} sale - Venta con relaciones cargadas
 * @returns {object} - Datos formateados para el reporte
 */
function prepararDatosVentaParaReporte(sale) {
  const ivaCalc = calcularIVA(sale.total, sale.country);
  const viernes = obtenerViernesDeLaSemana(sale.date);
  const destino = determinarHojaDestino(sale);
  
  return {
    // Datos básicos
    id: sale.id,
    folio: sale.folio,
    fecha: formatearFecha(sale.date),
    fechaObj: sale.date,
    cliente: sale.client?.name || 'Cliente',
    concepto: sale.items.map(i => i.modelo).join(', '),
    
    // Montos
    depositoConIVA: ivaCalc.conIVA,
    depositoSinIVA: ivaCalc.sinIVA,
    montoIVA: ivaCalc.montoIVA,
    total: sale.total,
    
    // Categorización
    categoryType: sale.categoryType,
    esServicio: esServicio(sale),
    
    // Semana
    semanaViernes: formatearFecha(viernes),
    numeroSemana: obtenerNumeroSemana(sale.date),
    
    // Vendedor
    vendedor: sale.createdBy?.name || 'N/A',
    vendedorId: sale.createdById,
    
    // Tipo de pago
    tipoPago: sale.paymentType || 'total',
    
    // Hojas destino
    vaAGeneral: destino.general,
    vaAComisiones: destino.comisiones,
    vaAComercializacion: destino.comercializacion,
    itemsComercializacion: destino.itemsComercializacion || [],
    itemsRegulador: destino.itemsRegulador || [],
    
    // Comercialización
    costoProveedor: sale.providerCost || 0,
    utilidad: ivaCalc.sinIVA - (sale.providerCost || 0),
    
    // Metadata
    pais: sale.country,
    aplicaIVA: ivaCalc.aplicaIVA
  };
}

// ============================================
// EXPORTAR FUNCIONES
// ============================================

module.exports = {
  // Constantes
  CATEGORIAS_PRODUCTOS,
  HOJA_DESTINO,
  IVA_FACTOR,
  
  // Categorización
  categorizarProducto,
  determinarHojaDestino,
  esServicio,
  
  // IVA
  calcularIVA,
  getIVAFactor,
  
  // Fechas
  obtenerViernesDeLaSemana,
  obtenerNumeroSemana,
  formatearFecha,
  
  // Comisiones
  obtenerAcumuladoMensual,
  encontrarReglaComision,
  calcularComisionVenta,
  registrarComision,
  
  // Preparación de datos
  prepararDatosVentaParaReporte
};