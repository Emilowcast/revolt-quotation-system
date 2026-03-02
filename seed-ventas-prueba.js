// seed-ventas-prueba.js
// Script para generar cotizaciones y ventas de prueba para enero y febrero 2026

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Datos de productos de ejemplo
const PRODUCTOS = [
  {
    modelo: 'RM-041-120',
    descripcion: 'REGULADOR AUTOMÁTICO DE VOLTAJE 4 KVA MONOFÁSICO 120V',
    precio: 8500,
    capacidad: '4 kVA'
  },
  {
    modelo: 'RM-042-220',
    descripcion: 'REGULADOR AUTOMÁTICO DE VOLTAJE 4 KVA BIFÁSICO 220V',
    precio: 9200,
    capacidad: '4 kVA'
  },
  {
    modelo: 'RM-101-120',
    descripcion: 'REGULADOR AUTOMÁTICO DE VOLTAJE 10 KVA MONOFÁSICO 120V',
    precio: 15000,
    capacidad: '10 kVA'
  },
  {
    modelo: 'RM-153-220',
    descripcion: 'REGULADOR AUTOMÁTICO DE VOLTAJE 15 KVA TRIFÁSICO 220V',
    precio: 28000,
    capacidad: '15 kVA'
  },
  {
    modelo: 'RM-203-220',
    descripcion: 'REGULADOR AUTOMÁTICO DE VOLTAJE 20 KVA TRIFÁSICO 220V',
    precio: 35000,
    capacidad: '20 kVA'
  },
  {
    modelo: 'RM-403-220',
    descripcion: 'REGULADOR AUTOMÁTICO DE VOLTAJE 40 KVA TRIFÁSICO 220V',
    precio: 62000,
    capacidad: '40 kVA'
  }
];

// Datos de clientes de ejemplo
const CLIENTES_EJEMPLO = [
  { nombre: 'Hugo Hernández', empresa: 'Nissan Mexicana', ciudad: 'Aguascalientes' },
  { nombre: 'María López', empresa: 'General Motors', ciudad: 'Silao' },
  { nombre: 'Carlos Ramírez', empresa: 'Volkswagen México', ciudad: 'Puebla' },
  { nombre: 'Ana Martínez', empresa: 'Audi México', ciudad: 'San José Chiapa' },
  { nombre: 'José García', empresa: 'BMW Group', ciudad: 'San Luis Potosí' },
  { nombre: 'Laura Sánchez', empresa: 'Mazda', ciudad: 'Salamanca' },
  { nombre: 'Pedro Torres', empresa: 'Honda', ciudad: 'Celaya' },
  { nombre: 'Sofía Morales', empresa: 'Toyota', ciudad: 'Guanajuato' },
  { nombre: 'Miguel Ángel Ruiz', empresa: 'KIA Motors', ciudad: 'Monterrey' },
  { nombre: 'Gabriela Fernández', empresa: 'Ford Motor Company', ciudad: 'Hermosillo' }
];

// Función para generar fecha aleatoria en un mes
function fechaAleatoria(año, mes) {
  const dia = Math.floor(Math.random() * 28) + 1; // Días 1-28 para evitar problemas
  return new Date(año, mes - 1, dia);
}

// Función para generar folio
function generarFolio(tipo, año, mes, numero) {
  const mesStr = String(mes).padStart(2, '0');
  const numStr = String(numero).padStart(4, '0');
  return `${tipo}-${año}${mesStr}-${numStr}`;
}

// Función principal
async function seedVentasPrueba() {
  console.log('🌱 Generando datos de prueba para enero y febrero 2026...\n');

  try {
    // 1. Obtener o crear usuario
    let usuario = await prisma.user.findFirst({
      where: { email: 'admin@revolt.com' }
    });

    if (!usuario) {
      console.log('⚠️  Usuario admin no encontrado, usando el primero disponible...');
      usuario = await prisma.user.findFirst();
      
      if (!usuario) {
        throw new Error('No hay usuarios en la BD. Crea uno primero.');
      }
    }

    console.log(`✅ Usuario: ${usuario.name} (ID: ${usuario.id})\n`);

    // 2. Crear o obtener clientes
    const clientesCreados = [];
    
    for (const clienteData of CLIENTES_EJEMPLO) {
      let cliente = await prisma.client.findFirst({
        where: { 
          name: clienteData.nombre,
          company: clienteData.empresa 
        }
      });

      if (!cliente) {
        cliente = await prisma.client.create({
          data: {
            name: clienteData.nombre,
            company: clienteData.empresa,
            email: `${clienteData.nombre.toLowerCase().replace(/\s/g, '.')}@${clienteData.empresa.toLowerCase().replace(/\s/g, '')}.com`,
            phone: `${Math.floor(Math.random() * 9000000000) + 1000000000}`,
            address: `Av. Industrial ${Math.floor(Math.random() * 1000)}, ${clienteData.ciudad}, México`,
            estado: clienteData.ciudad // Usar campo 'estado' que sí existe
          }
        });
        console.log(`  ✅ Cliente creado: ${cliente.name} - ${cliente.company}`);
      }

      clientesCreados.push(cliente);
    }

    console.log(`\n📊 Total clientes disponibles: ${clientesCreados.length}\n`);

    // 3. Generar ventas para ENERO y FEBRERO
    const meses = [
      { mes: 1, nombre: 'ENERO', cantidad: 15 },
      { mes: 2, nombre: 'FEBRERO', cantidad: 12 }
    ];

    let totalVentas = 0;

    for (const mesData of meses) {
      console.log(`📅 Generando ventas de ${mesData.nombre}...\n`);

      for (let i = 0; i < mesData.cantidad; i++) {
        // Seleccionar cliente aleatorio
        const cliente = clientesCreados[Math.floor(Math.random() * clientesCreados.length)];
        
        // Seleccionar producto aleatorio
        const producto = PRODUCTOS[Math.floor(Math.random() * PRODUCTOS.length)];
        
        // Cantidad aleatoria (1-3)
        const cantidad = Math.floor(Math.random() * 3) + 1;
        
        // Calcular precios
        const subtotal = producto.precio * cantidad;
        const descuento = Math.random() > 0.7 ? subtotal * 0.1 : 0; // 30% de probabilidad de descuento
        const subtotalConDescuento = subtotal - descuento;
        const iva = subtotalConDescuento * 0.16;
        const total = subtotalConDescuento + iva;

        // Generar folio
        const numeroVenta = totalVentas + 1;
        const folio = generarFolio('COT', 2026, mesData.mes, numeroVenta);

        // Fecha aleatoria del mes
        const fecha = fechaAleatoria(2026, mesData.mes);

        // Crear cotización
        const cotizacion = await prisma.quote.create({
          data: {
            folio,
            date: fecha,
            clientId: cliente.id,
            createdById: usuario.id,
            subtotal,
            discount: descuento,
            tax: iva,
            total,
            netMxn: total, // ⭐ AGREGAR netMxn
            currency: 'MXN',
            exchangeRate: 1.0,
            status: 'convertida',
            tiempoEntrega: '15 días hábiles',
            formaPago: Math.random() > 0.5 ? 'Anticipo 50% + Saldo contra entrega' : 'Pago total',
            items: {
              create: [{
                modelo: producto.modelo,
                descripcion: producto.descripcion,
                unitPrice: producto.precio,
                qty: cantidad,
                subtotal: subtotal
              }]
            }
          }
        });

        // Crear venta
        const venta = await prisma.sale.create({
          data: {
            folio,
            date: fecha,
            quoteId: cotizacion.id,
            clientId: cliente.id,
            createdById: usuario.id,
            subtotal,
            discount: descuento,
            tax: iva,
            total,
            currency: 'MXN',
            exchangeRate: 1.0,
            netMxn: total,
            status: 'completada',
            paymentStatus: 'paid',
            deliveryStatus: 'delivered',
            tiempoEntrega: '15 días hábiles',
            formaPago: Math.random() > 0.5 ? 'anticipo' : 'total',
            items: {
              create: [{
                modelo: producto.modelo,
                descripcion: producto.descripcion,
                unitPrice: producto.precio,
                qty: cantidad,
                subtotal: subtotal
              }]
            }
          }
        });

        console.log(`  ✅ ${folio} | ${cliente.name.substring(0, 20).padEnd(20)} | ${producto.modelo.padEnd(12)} | $${total.toLocaleString('es-MX', { minimumFractionDigits: 2 })}`);

        totalVentas++;
      }

      console.log('');
    }

    console.log(`\n🎉 COMPLETADO!`);
    console.log(`   Total de ventas generadas: ${totalVentas}`);
    console.log(`   Enero: 15 ventas`);
    console.log(`   Febrero: 12 ventas\n`);

  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Ejecutar
seedVentasPrueba()
  .then(() => {
    console.log('✅ Script completado exitosamente\n');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Error fatal:', error);
    process.exit(1);
  });