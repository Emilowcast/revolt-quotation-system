// server.js - Sistema completo con Prisma + Ventas y Órdenes de Producción
const { execFile } = require('child_process');
const os = require('os');
const { generarReporteMensual, obtenerReportes } = require('./utils/reportes-service');
const express = require('express');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const bodyParser = require('body-parser');
const multer = require('multer');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { PrismaClient } = require('@prisma/client');
const ExcelJS = require('exceljs');
const nodemailer = require('nodemailer');
require('dotenv').config();
const app = express();
const prisma = new PrismaClient();
// ⭐ IMPORTS PARA AUTENTICACIÓN
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { 
  hashPassword,
  requireAuth,
  requireAdmin,
  AUTH_CONFIG,
  verifyPassword,
  generateToken,
  isValidEmail,
  validatePassword,
  isValidRole
} = require('./auth');

// ============================================
// EMAIL CONFIGURATION (Nodemailer)
// ============================================
const emailConfig = {
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.EMAIL_PORT) || 587,
  secure: process.env.EMAIL_SECURE === 'true',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
};
const { spawn } = require('child_process');

// Crear transportador de Nodemailer
let transporter = null;
try {
  if (process.env.EMAIL_USER && process.env.EMAIL_PASSWORD) {
    transporter = nodemailer.createTransport(emailConfig);
    console.log('✅ Nodemailer configurado correctamente');
  } else {
    console.warn('⚠️ EMAIL_USER o EMAIL_PASSWORD no configurados en .env');
  }
} catch (e) {
  console.error('❌ Error configurando Nodemailer:', e.message);
}

app.use(express.static(path.join(__dirname, 'public')));
app.use('/templates', express.static(path.join(__dirname, 'templates')));
app.use(bodyParser.json({ limit: '30mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
// ⭐ MIDDLEWARE DE COOKIES (para autenticación)
app.use(cookieParser());

// ============================================
// RATE LIMITING (Protección contra fuerza bruta)
// ============================================

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 20, // 20 intentos
  message: 'Demasiados intentos de login. Intenta de nuevo en 15 minutos.',
  standardHeaders: true,
  legacyHeaders: false,
});

// ⭐ RUTA RAÍZ - Debe ir DESPUÉS de static pero ANTES de otras rutas
app.get('/', (req, res) => {
  res.redirect('/dashboard.html');
});

const TEMPLATES_DIR = path.join(__dirname, 'templates');
const CALIB_DIR = path.join(TEMPLATES_DIR, 'calibrations');
const CALIBRATIONS_DIR = CALIB_DIR; // ⭐ ALIAS para compatibilidad
const ORDERS_DIR = path.join(__dirname, 'orders');

if (!fs.existsSync(TEMPLATES_DIR)) fs.mkdirSync(TEMPLATES_DIR);
if (!fs.existsSync(CALIB_DIR)) fs.mkdirSync(CALIB_DIR);
if (!fs.existsSync(ORDERS_DIR)) fs.mkdirSync(ORDERS_DIR);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TEMPLATES_DIR),
  filename: (req, file, cb) => cb(null, path.basename(file.originalname))
});
const upload = multer({ storage });

// ============================================
// CONFIGURACIÓN MULTER PARA FICHAS TÉCNICAS
// ============================================

const FICHAS_DIR = path.join(__dirname, 'public', 'fichas');

// Crear directorio si no existe
if (!fs.existsSync(FICHAS_DIR)) {
  fs.mkdirSync(FICHAS_DIR, { recursive: true });
  console.log('✅ Directorio de fichas técnicas creado');
}

// Configuración de multer para fichas técnicas
const fichasStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, FICHAS_DIR);
  },
  filename: (req, file, cb) => {
    // Generar nombre único con timestamp
    const timestamp = Date.now();
    const originalName = file.originalname;
    const ext = path.extname(originalName);
    const nameWithoutExt = path.basename(originalName, ext);
    
    // Sanitizar nombre (eliminar caracteres especiales)
    const safeName = nameWithoutExt
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .substring(0, 50); // Limitar longitud
    
    const uniqueName = `${timestamp}_${safeName}${ext}`;
    cb(null, uniqueName);
  }
});

// Filtro para validar tipos de archivo
const fichasFileFilter = (req, file, cb) => {
  const allowedTypes = ['application/pdf', 'image/png', 'image/jpeg'];
  const allowedExts = ['.pdf', '.png', '.jpg', '.jpeg'];
  
  const ext = path.extname(file.originalname).toLowerCase();
  
  if (allowedTypes.includes(file.mimetype) && allowedExts.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Solo se permiten archivos PDF, PNG o JPG'), false);
  }
};

const uploadFicha = multer({
  storage: fichasStorage,
  fileFilter: fichasFileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB máximo
  }
});

function safeName(name) { return path.basename(String(name || '')); }

function loadCalibrationForTemplate(templateFilename) {
  const safe = safeName(templateFilename);
  const calibPath = path.join(CALIB_DIR, safe + '.json');
  
  if (!fs.existsSync(calibPath)) return null;
  
  try {
    const raw = fs.readFileSync(calibPath, 'utf8');
    const json = JSON.parse(raw);
    
    // ✅ DETECTAR FORMATO NUEVO (multi-página) vs ANTIGUO (single-page)
    let calibration;
    
    if (json.pages) {
      // ✨ FORMATO NUEVO: Multi-página
      calibration = { pages: {} };
      
      Object.keys(json.pages).forEach(pageNum => {
        const pageData = json.pages[pageNum];
        calibration.pages[pageNum] = {
          fields: {},
          table: pageData.table || { startY: 0.61, lineHeight: 0.045 }
        };
        
        // Normalizar campos de cada página
        Object.keys(pageData.fields || {}).forEach(fieldName => {
          const f = pageData.fields[fieldName];
          calibration.pages[pageNum].fields[fieldName] = {
            x: Number(f.x),
            y: Number(f.y),
            anchor: (typeof f.anchor === 'string') ? f.anchor : 'left',
            vAnchor: (typeof f.vAnchor === 'string') ? f.vAnchor : 'baseline',
            fontSize: Number(f.fontSize) || 10,
            offsetX: (f.offsetX === undefined) ? 0 : Number(f.offsetX),
            offsetY: (f.offsetY === undefined) ? 0 : Number(f.offsetY),
            widthFrac: Number(f.widthFrac) || 0.15,
            heightFrac: Number(f.heightFrac) || 0.02,
            bold: f.bold || false,
            justify: f.justify || false,
            sampleValue: f.sampleValue || '',
            type: f.type || 'text'
          };
          
          // Eliminar campos con coordenadas inválidas
          if (!isFinite(calibration.pages[pageNum].fields[fieldName].x) || 
              !isFinite(calibration.pages[pageNum].fields[fieldName].y)) {
            delete calibration.pages[pageNum].fields[fieldName];
          }
        });
      });
      
      calibration.globalOffsetY = Number(json.globalOffsetY || 0);
      
    } else {
      // 🔄 FORMATO ANTIGUO: Convertir a multi-página (página 1 por defecto)
      console.log('📦 Convirtiendo calibración antigua a formato multi-página...');
      
      calibration = {
        pages: {
          '1': {
            fields: {},
            table: json.table || { startY: 0.61, lineHeight: 0.045 }
          }
        },
        globalOffsetY: Number(json.globalOffsetY || 0)
      };
      
      // Migrar campos antiguos a página 1
      Object.keys(json.fields || {}).forEach(fieldName => {
        const f = json.fields[fieldName];
        calibration.pages['1'].fields[fieldName] = {
          x: Number(f.x),
          y: Number(f.y),
          anchor: (typeof f.anchor === 'string') ? f.anchor : 'left',
          vAnchor: (typeof f.vAnchor === 'string') ? f.vAnchor : 'baseline',
          fontSize: Number(f.fontSize) || 10,
          offsetX: (f.offsetX === undefined) ? 0 : Number(f.offsetX),
          offsetY: (f.offsetY === undefined) ? 0 : Number(f.offsetY),
          widthFrac: Number(f.widthFrac) || 0.15,
          heightFrac: Number(f.heightFrac) || 0.02,
          bold: f.bold || false,
          justify: f.justify || false,
          sampleValue: f.sampleValue || '',
          type: f.type || 'text'
        };
        
        if (!isFinite(calibration.pages['1'].fields[fieldName].x) || 
            !isFinite(calibration.pages['1'].fields[fieldName].y)) {
          delete calibration.pages['1'].fields[fieldName];
        }
      });
    }
    
    console.log('✅ Calibración cargada:', {
      template: safe,
      format: json.pages ? 'multi-página' : 'legacy (convertido)',
      pages: Object.keys(calibration.pages).length,
      totalFields: Object.keys(calibration.pages).reduce((sum, pageNum) => {
        return sum + Object.keys(calibration.pages[pageNum].fields).length;
      }, 0)
    });
    
    return calibration;
    
  } catch (e) {
    console.error('❌ Error leyendo calibración:', e.message);
    return null;
  }
}


// ============================================
// TEMPLATES ENDPOINTS
// ============================================

app.get('/api/templates', (req, res) => {
  const files = fs.readdirSync(TEMPLATES_DIR)
    .filter(f => !fs.lstatSync(path.join(TEMPLATES_DIR, f)).isDirectory())
    .filter(f => /\.(pdf|png|jpg|jpeg)$/i.test(f))
    .map(f => ({ name: f, calibrated: fs.existsSync(path.join(CALIB_DIR, f + '.json')) }));
  res.json({ ok: true, templates: files });
});

app.post('/api/templates/upload', upload.single('template'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file' });
  res.json({ ok: true, filename: req.file.filename, path: `/templates/${req.file.filename}` });
});

// DELETE /api/templates/:name
app.delete('/api/templates/:name', (req, res) => {
  const { name } = req.params;
  const templatePath = path.join(__dirname, 'templates', name);
  const calibrationPath = path.join(__dirname, 'calibrations', `${name}.json`);
  
  try {
    // Eliminar plantilla
    if (fs.existsSync(templatePath)) {
      fs.unlinkSync(templatePath);
    }
    
    // Eliminar calibración si existe
    if (fs.existsSync(calibrationPath)) {
      fs.unlinkSync(calibrationPath);
    }
    
    res.json({ success: true, message: 'Plantilla eliminada' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/templates/:name/calibration', (req, res) => {
  const name = safeName(req.params.name);
  const c = loadCalibrationForTemplate(name);
  if (!c) return res.status(404).json({ ok: false, error: 'No calibration' });
  res.json({ ok: true, calibration: c });
});

app.post('/save-calibration', (req, res) => {
  try {
    const templateName = safeName(req.query.template || req.body.templateName || req.body.template);
    if (!templateName) return res.status(400).json({ ok: false, error: 'Falta nombre de plantilla' });
    const payload = req.body || {};
    payload.fields = payload.fields || {};
    payload.table = payload.table || { startY: 0.61, lineHeight: 0.045 };
    for (const k of Object.keys(payload.fields)) {
      const f = payload.fields[k];
      f.x = Number(f.x);
      f.y = Number(f.y);
      f.anchor = (typeof f.anchor === 'string') ? f.anchor : 'left';
      f.vAnchor = (typeof f.vAnchor === 'string') ? f.vAnchor : 'baseline';
      f.fontSize = Number(f.fontSize) || 10;
      f.offsetX = (f.offsetX === undefined) ? 0 : Number(f.offsetX);
      f.offsetY = (f.offsetY === undefined) ? 0 : Number(f.offsetY);
    }
    payload.globalOffsetY = (payload.globalOffsetY === undefined) ? 0 : Number(payload.globalOffsetY);
    const outPath = path.join(CALIB_DIR, templateName + '.json');
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
    console.log('✅ Calibración guardada:', templateName);
    res.json({ ok: true, path: `/templates/calibrations/${templateName}.json` });
  } catch (e) {
    console.error('❌ Error guardando calibración:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// CLIENTS API (Prisma)
// ============================================

app.get('/api/clients', async (req, res) => {
  try {
    const search = req.query.search || '';
    const clients = await prisma.client.findMany({
      where: search ? {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { company: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } }
        ]
      } : {},
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    res.json({ ok: true, clients });
  } catch (e) {
    console.error('Error fetching clients:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/clients/:id', async (req, res) => {
  try {
    const client = await prisma.client.findUnique({
      where: { id: parseInt(req.params.id) }
    });
    if (!client) return res.status(404).json({ ok: false, error: 'Cliente no encontrado' });
    res.json({ ok: true, client });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/clients', async (req, res) => {
  try {
    const { name, company, phone, email, address, estado, notes } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: 'El nombre es requerido' });
    
    const client = await prisma.client.create({
      data: { name, company, phone, email, address, estado, notes }
    });
    
    console.log('✅ Cliente creado:', client.id);
    res.json({ ok: true, client });
  } catch (e) {
    console.error('❌ Error creando cliente:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.put('/api/clients/:id', async (req, res) => {
  try {
    const { name, company, phone, email, address, estado, notes } = req.body;
    const client = await prisma.client.update({
      where: { id: parseInt(req.params.id) },
      data: { name, company, phone, email, address, estado, notes }
    });
    res.json({ ok: true, client });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/clients/:id', async (req, res) => {
  try {
    await prisma.client.delete({
      where: { id: parseInt(req.params.id) }
    });
    res.json({ ok: true, message: 'Cliente eliminado' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// PRODUCTS API (Prisma) - ORDEN CORREGIDO
// ============================================

// ⭐ 1. RUTAS ESPECÍFICAS PRIMERO

// Descargar template Excel
app.get('/api/products/template', async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Productos');
    
    worksheet.columns = [
      { header: 'MODELO', key: 'model', width: 20 },
      { header: 'DESCRIPCIÓN', key: 'description', width: 40 },
      { header: 'PRECIO', key: 'price', width: 15 },
      { header: 'MONEDA', key: 'currency', width: 10 },
      { header: 'FICHA', key: 'ficha', width: 30 }
    ];
    
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { 
      type: 'pattern', 
      pattern: 'solid', 
      fgColor: { argb: 'FFF62E41' } 
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    headerRow.height = 25;
    
    worksheet.addRow({
      model: 'BCN-10KVA-2F-220V',
      description: 'Regulador industrial 10kVA 2Φ 220V',
      price: 8500.00,
      currency: 'USD',
      ficha: 'bcn_10kva.pdf'
    });
    
    worksheet.addRow({
      model: 'BSN-4KVA-2F-220V',
      description: 'Regulador básico 4kVA 2Φ 220V',
      price: 4500.00,
      currency: 'USD',
      ficha: 'bsn_4kva.pdf'
    });
    
    worksheet.addRow({
      model: 'UPS-1000VA',
      description: 'UPS 1000VA',
      price: 450.00,
      currency: 'USD',
      ficha: ''
    });
    
    worksheet.getColumn('price').numFmt = '"$"#,##0.00';
    
    worksheet.addRow([]);
    worksheet.addRow(['NOTAS:']);
    worksheet.addRow(['- MODELO y PRECIO son campos requeridos']);
    worksheet.addRow(['- MONEDA por defecto es USD']);
    worksheet.addRow(['- FICHA es opcional (nombre del archivo)']);
    worksheet.addRow(['- No modifiques los encabezados de la primera fila']);
    worksheet.addRow(['- Puedes agregar tantas filas como necesites']);
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=template_productos.xlsx');
    
    await workbook.xlsx.write(res);
    res.end();
    
  } catch (e) {
    console.error('❌ Error generando template:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ⭐ 2. IMPORT (procesar Excel) - VERSIÓN CORREGIDA PARA EXTRAER MODELO
app.post('/api/products/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No se proporcionó archivo' });
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);
    
    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      return res.status(400).json({ ok: false, error: 'El archivo Excel está vacío' });
    }

    const products = [];
    const errors = [];
    
    // ⭐ FUNCIÓN PARA EXTRAER MODELO DE LA DESCRIPCIÓN
    function extractModeloFromDescription(descripcion) {
      if (!descripcion) return null;
      
      // Buscar patrón "Modelo: XXXXX"
      const match = descripcion.match(/Modelo:\s*([^\n]+)/i);
      if (match && match[1]) {
        return match[1].trim();
      }
      
      return null;
    }
    
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Saltar encabezados
      
      const modeloGenerico = row.getCell(1).value?.toString().trim();
      const descripcion = row.getCell(2).value?.toString().trim() || '';
      const precioRaw = row.getCell(3).value;
      const currency = row.getCell(4).value?.toString().trim() || 'USD';
      const ficha = row.getCell(5).value?.toString().trim() || null;
      
      // ⭐ EXTRAER MODELO REAL DE LA DESCRIPCIÓN
      const modeloReal = extractModeloFromDescription(descripcion);
      
      if (!modeloReal) {
        errors.push({ 
          row: rowNumber, 
          error: `No se pudo extraer el modelo de la descripción. Verifica que contenga "Modelo: XXXXX"`,
          descripcion: descripcion.substring(0, 100) + '...'
        });
        return;
      }
      
      const precio = parseFloat(precioRaw);
      if (isNaN(precio) || precio < 0) {
        errors.push({ row: rowNumber, error: 'Precio inválido', modelo: modeloReal });
        return;
      }
      
      // ⭐ CONSTRUIR DESCRIPCIÓN COMPLETA
      // Combinar modelo genérico + descripción detallada
      const descripcionCompleta = `${modeloGenerico}\n\n${descripcion}`;
      
      products.push({
        model: modeloReal, // ⭐ USAR MODELO EXTRAÍDO COMO CLAVE
        description: descripcionCompleta,
        price: precio,
        currency,
        ficha
      });
      
      console.log(`✅ Fila ${rowNumber}: ${modeloReal} - $${precio}`);
    });
    
    // Eliminar archivo temporal
    fs.unlinkSync(req.file.path);
    
    if (errors.length > 0 && products.length === 0) {
      return res.status(400).json({ 
        ok: false, 
        error: 'No se pudo importar ningún producto', 
        errors 
      });
    }
    
    console.log(`📦 Procesados: ${products.length} productos, ${errors.length} errores`);
    
    res.json({ 
      ok: true, 
      preview: products, 
      errors,
      message: `${products.length} productos listos para importar${errors.length > 0 ? ` (${errors.length} errores encontrados)` : ''}`
    });
    
  } catch (e) {
    console.error('❌ Error importando productos:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ⭐ 3. CONFIRMAR IMPORTACIÓN
app.post('/api/products/import/confirm', async (req, res) => {
  try {
    const { products } = req.body;
    
    console.log('📦 [CONFIRM] Recibiendo productos:', products?.length || 0);
    
    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ ok: false, error: 'No hay productos para importar' });
    }
    
    function sanitizeForDB(text) {
      if (!text) return text;
      
      const replacements = {
        'Φ': 'F', 'φ': 'f', 'Ω': 'Ohm', 'μ': 'u', '°': 'deg'
      };
      
      let sanitized = String(text);
      for (const [special, replacement] of Object.entries(replacements)) {
        sanitized = sanitized.replace(new RegExp(special, 'g'), replacement);
      }
      
      return sanitized;
    }
    
    let created = 0;
    let updated = 0;
    const results = [];
    
    for (const product of products) {
      try {
        const sanitizedProduct = {
          model: sanitizeForDB(product.model),
          description: sanitizeForDB(product.description),
          price: parseFloat(product.price),
          currency: product.currency || 'USD',
          ficha: product.ficha
        };
        
        console.log(`  📝 Procesando: ${sanitizedProduct.model}`);
        
        const existing = await prisma.product.findUnique({
          where: { model: sanitizedProduct.model }
        });
        
        if (existing) {
          await prisma.product.update({
            where: { model: sanitizedProduct.model },
            data: {
              description: sanitizedProduct.description,
              price: sanitizedProduct.price,
              currency: sanitizedProduct.currency,
              ficha: sanitizedProduct.ficha
            }
          });
          updated++;
          results.push({ model: sanitizedProduct.model, action: 'updated' });
          console.log(`    ✅ Actualizado`);
        } else {
          await prisma.product.create({
            data: sanitizedProduct
          });
          created++;
          results.push({ model: sanitizedProduct.model, action: 'created' });
          console.log(`    ✅ Creado`);
        }
      } catch (err) {
        console.error(`    ❌ Error:`, err.message);
        results.push({ model: product.model, action: 'error', error: err.message });
      }
    }
    
    console.log(`✅ Importación completada: ${created} creados, ${updated} actualizados`);
    
    res.json({ 
      ok: true, 
      created, 
      updated, 
      results,
      message: `Importación exitosa: ${created} productos creados, ${updated} actualizados`
    });
    
  } catch (e) {
    console.error('❌ Error confirmando importación:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ⭐ 4. GET producto por modelo
app.get('/api/products/model/:model', async (req, res) => {
  try {
    const model = req.params.model;
    
    const product = await prisma.product.findUnique({
      where: { model: model }
    });
    
    if (!product) {
      return res.status(404).json({ ok: false, error: 'Producto no encontrado' });
    }
    
    res.json({ ok: true, product });
  } catch (e) {
    console.error('Error fetching product by model:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// GET ALL PRODUCTS (CON PAGINACIÓN)
// ============================================
app.get('/api/products', async (req, res) => {
  try {
    const search = req.query.search || '';
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    
    console.log('📊 [GET /api/products] Query params:', { 
      search, 
      page, 
      limit, 
      skip 
    });
    
    const where = search ? {
      OR: [
        { model: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } }
      ]
    } : {};
    
    // Contar total de productos
    const total = await prisma.product.count({ where });
    
    console.log(`  📦 Total en base de datos: ${total} productos`);
    
    // Obtener productos de la página actual
    const products = await prisma.product.findMany({
      where,
      orderBy: { model: 'asc' },
      skip,
      take: limit
    });
    
    const totalPages = Math.ceil(total / limit);
    
    console.log(`  ✅ Devolviendo página ${page}/${totalPages}: ${products.length} productos`);
    
    // ⭐ ESTRUCTURA COMPLETA CON PAGINACIÓN
    const response = { 
      ok: true, 
      products: products,
      pagination: {
        total: total,
        page: page,
        limit: limit,
        totalPages: totalPages,
        hasMore: page < totalPages,
        hasPrev: page > 1
      }
    };
    
    console.log('  📤 Estructura de respuesta:', {
      ok: response.ok,
      productsCount: response.products.length,
      pagination: response.pagination
    });
    
    res.json(response);
    
  } catch (e) {
    console.error('❌ [GET /api/products] Error:', e);
    res.status(500).json({ 
      ok: false, 
      error: e.message 
    });
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    
    if (isNaN(id)) {
      return res.status(400).json({ ok: false, error: 'ID inválido' });
    }
    
    const product = await prisma.product.findUnique({
      where: { id: id }
    });
    
    if (!product) {
      return res.status(404).json({ ok: false, error: 'Producto no encontrado' });
    }
    
    res.json({ ok: true, product });
  } catch (e) {
    console.error('Error fetching product:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/products', async (req, res) => {
  try {
    const { model, description, price, currency, ficha } = req.body;
    if (!model) return res.status(400).json({ ok: false, error: 'El modelo es requerido' });
    if (!price) return res.status(400).json({ ok: false, error: 'El precio es requerido' });
    
    const product = await prisma.product.create({
      data: { model, description, price: parseFloat(price), currency: currency || 'USD', ficha }
    });
    
    console.log('✅ Producto creado:', product.id);
    res.json({ ok: true, product });
  } catch (e) {
    console.error('❌ Error creando producto:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.put('/api/products/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    
    if (isNaN(id)) {
      return res.status(400).json({ ok: false, error: 'ID inválido' });
    }
    
    const { model, description, price, currency, ficha } = req.body;
    const product = await prisma.product.update({
      where: { id: id },
      data: { model, description, price: parseFloat(price), currency, ficha }
    });
    res.json({ ok: true, product });
  } catch (e) {
    console.error('Error updating product:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    
    if (isNaN(id)) {
      return res.status(400).json({ ok: false, error: 'ID inválido' });
    }
    
    await prisma.product.delete({
      where: { id: id }
    });
    res.json({ ok: true, message: 'Producto eliminado' });
  } catch (e) {
    console.error('Error deleting product:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});
// ============================================
// PRODUCTS IMPORT FROM EXCEL
// ============================================

app.post('/api/products/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No se proporcionó archivo' });
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);
    
    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      return res.status(400).json({ ok: false, error: 'El archivo Excel está vacío' });
    }

    const products = [];
    const errors = [];
    
    // Leer filas (empezando desde fila 2, asumiendo que fila 1 son encabezados)
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Saltar encabezados
      
      const modelo = row.getCell(1).value?.toString().trim();
      const descripcion = row.getCell(2).value?.toString().trim() || '';
      const precioRaw = row.getCell(3).value;
      const currency = row.getCell(4).value?.toString().trim() || 'USD';
      const ficha = row.getCell(5).value?.toString().trim() || null;
      
      // Validación
      if (!modelo) {
        errors.push({ row: rowNumber, error: 'Modelo es requerido' });
        return;
      }
      
      const precio = parseFloat(precioRaw);
      if (isNaN(precio) || precio < 0) {
        errors.push({ row: rowNumber, error: 'Precio inválido', modelo });
        return;
      }
      
      products.push({
        model: modelo,
        description: descripcion,
        price: precio,
        currency,
        ficha
      });
    });
    
    // Eliminar archivo temporal
    fs.unlinkSync(req.file.path);
    
    if (errors.length > 0 && products.length === 0) {
      return res.status(400).json({ 
        ok: false, 
        error: 'No se pudo importar ningún producto', 
        errors 
      });
    }
    
    // Retornar preview para confirmación
    res.json({ 
      ok: true, 
      preview: products, 
      errors,
      message: `${products.length} productos listos para importar${errors.length > 0 ? ` (${errors.length} errores encontrados)` : ''}`
    });
    
  } catch (e) {
    console.error('❌ Error importando productos:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Confirmar importación
app.post('/api/products/import/confirm', async (req, res) => {
  try {
    const { products } = req.body;
    
    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ ok: false, error: 'No hay productos para importar' });
    }
    
    // ⭐ Función para sanitizar texto
    function sanitizeForDB(text) {
      if (!text) return text;
      
      const replacements = {
        'Φ': 'F',
        'φ': 'f',
        'Ω': 'Ohm',
        'μ': 'u',
        '°': 'deg'
      };
      
      let sanitized = String(text);
      for (const [special, replacement] of Object.entries(replacements)) {
        sanitized = sanitized.replace(new RegExp(special, 'g'), replacement);
      }
      
      return sanitized;
    }
    
    let created = 0;
    let updated = 0;
    const results = [];
    
    for (const product of products) {
      try {
        // ⭐ Sanitizar antes de guardar
        const sanitizedProduct = {
          model: sanitizeForDB(product.model),
          description: sanitizeForDB(product.description),
          price: product.price,
          currency: product.currency,
          ficha: product.ficha
        };
        
        const existing = await prisma.product.findUnique({
          where: { model: sanitizedProduct.model }
        });
        
        if (existing) {
          await prisma.product.update({
            where: { model: sanitizedProduct.model },
            data: {
              description: sanitizedProduct.description,
              price: sanitizedProduct.price,
              currency: sanitizedProduct.currency,
              ficha: sanitizedProduct.ficha
            }
          });
          updated++;
          results.push({ model: sanitizedProduct.model, action: 'updated' });
        } else {
          await prisma.product.create({
            data: sanitizedProduct
          });
          created++;
          results.push({ model: sanitizedProduct.model, action: 'created' });
        }
      } catch (err) {
        results.push({ model: product.model, action: 'error', error: err.message });
      }
    }
    
    console.log(`✅ Importación completada: ${created} creados, ${updated} actualizados`);
    
    res.json({ 
      ok: true, 
      created, 
      updated, 
      results,
      message: `Importación exitosa: ${created} productos creados, ${updated} actualizados`
    });
    
  } catch (e) {
    console.error('❌ Error confirmando importación:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.put('/api/products/:id', async (req, res) => {
  try {
    const { model, description, price, currency, ficha } = req.body;
    const product = await prisma.product.update({
      where: { id: parseInt(req.params.id) },
      data: { model, description, price: parseFloat(price), currency, ficha }
    });
    res.json({ ok: true, product });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    await prisma.product.delete({
      where: { id: parseInt(req.params.id) }
    });
    res.json({ ok: true, message: 'Producto eliminado' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// FICHAS TÉCNICAS - UPLOAD Y GESTIÓN
// ============================================

/**
 * POST /api/products/:id/ficha
 * Subir ficha técnica para un producto
 */
app.post('/api/products/:id/ficha', uploadFicha.single('ficha'), async (req, res) => {
  try {
    const productId = parseInt(req.params.id);
    
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No se proporcionó archivo' });
    }
    
    console.log('📄 Subiendo ficha técnica:', {
      productId,
      filename: req.file.filename,
      originalname: req.file.originalname,
      size: req.file.size
    });
    
    // Verificar que el producto existe
    const product = await prisma.product.findUnique({
      where: { id: productId }
    });
    
    if (!product) {
      // Eliminar archivo si el producto no existe
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ ok: false, error: 'Producto no encontrado' });
    }
    
    // Si el producto ya tiene una ficha, eliminar la anterior
    if (product.ficha) {
      const oldFichaPath = path.join(FICHAS_DIR, product.ficha);
      if (fs.existsSync(oldFichaPath)) {
        fs.unlinkSync(oldFichaPath);
        console.log('🗑️ Ficha anterior eliminada:', product.ficha);
      }
    }
    
    // Actualizar producto con el nombre de la nueva ficha
    const updatedProduct = await prisma.product.update({
      where: { id: productId },
      data: { ficha: req.file.filename }
    });
    
    console.log('✅ Ficha técnica guardada:', req.file.filename);
    
    res.json({
      ok: true,
      filename: req.file.filename,
      url: `/fichas/${req.file.filename}`,
      product: updatedProduct
    });
    
  } catch (e) {
    console.error('❌ Error subiendo ficha:', e);
    
    // Limpiar archivo si hubo error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * DELETE /api/products/:id/ficha
 * Eliminar ficha técnica de un producto
 */
app.delete('/api/products/:id/ficha', async (req, res) => {
  try {
    const productId = parseInt(req.params.id);
    
    const product = await prisma.product.findUnique({
      where: { id: productId }
    });
    
    if (!product) {
      return res.status(404).json({ ok: false, error: 'Producto no encontrado' });
    }
    
    if (!product.ficha) {
      return res.status(400).json({ ok: false, error: 'El producto no tiene ficha técnica' });
    }
    
    // Eliminar archivo físico
    const fichaPath = path.join(FICHAS_DIR, product.ficha);
    if (fs.existsSync(fichaPath)) {
      fs.unlinkSync(fichaPath);
      console.log('🗑️ Archivo eliminado:', product.ficha);
    }
    
    // Actualizar producto
    const updatedProduct = await prisma.product.update({
      where: { id: productId },
      data: { ficha: null }
    });
    
    console.log('✅ Ficha técnica eliminada del producto:', product.model);
    
    res.json({ ok: true, product: updatedProduct });
    
  } catch (e) {
    console.error('❌ Error eliminando ficha:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/products/:id/ficha
 * Obtener URL de la ficha técnica
 */
app.get('/api/products/:id/ficha', async (req, res) => {
  try {
    const productId = parseInt(req.params.id);
    
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, model: true, ficha: true }
    });
    
    if (!product) {
      return res.status(404).json({ ok: false, error: 'Producto no encontrado' });
    }
    
    if (!product.ficha) {
      return res.status(404).json({ ok: false, error: 'El producto no tiene ficha técnica' });
    }
    
    // Verificar que el archivo existe
    const fichaPath = path.join(FICHAS_DIR, product.ficha);
    if (!fs.existsSync(fichaPath)) {
      return res.status(404).json({ ok: false, error: 'Archivo de ficha no encontrado' });
    }
    
    res.json({
      ok: true,
      filename: product.ficha,
      url: `/fichas/${product.ficha}`,
      product: product
    });
    
  } catch (e) {
    console.error('❌ Error obteniendo ficha:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Servir archivos de fichas estáticamente
app.use('/fichas', express.static(FICHAS_DIR));

// ============================================
// CONFIGURACIÓN MULTER PARA FIRMAS DE USUARIOS
// ============================================

const SIGNATURES_DIR = path.join(__dirname, 'public', 'signatures');

// Crear directorio si no existe
if (!fs.existsSync(SIGNATURES_DIR)) {
  fs.mkdirSync(SIGNATURES_DIR, { recursive: true });
  console.log('✅ Directorio de firmas creado');
}

// Configuración de multer para firmas
const signaturesStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, SIGNATURES_DIR);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const userId = req.user?.id || 'unknown';
    const ext = path.extname(file.originalname);
    const uniqueName = `signature_${userId}_${timestamp}${ext}`;
    cb(null, uniqueName);
  }
});

// Filtro para validar tipos de archivo (solo imágenes)
const signaturesFileFilter = (req, file, cb) => {
  const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg'];
  const allowedExts = ['.png', '.jpg', '.jpeg'];
  
  const ext = path.extname(file.originalname).toLowerCase();
  
  if (allowedTypes.includes(file.mimetype) && allowedExts.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Solo se permiten archivos PNG o JPG'), false);
  }
};

const uploadSignature = multer({
  storage: signaturesStorage,
  fileFilter: signaturesFileFilter,
  limits: {
    fileSize: 2 * 1024 * 1024 // 2MB máximo
  }
});

// Servir archivos de firmas estáticamente
app.use('/signatures', express.static(SIGNATURES_DIR));

console.log('✅ Configuración de firmas lista');

// ============================================
// RUTAS - VENTAS (SALES)
// ============================================

// GET ALL SALES (CON PAGINACIÓN)
app.get('/api/sales', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    console.log('📊 [GET /api/sales] Query params:', { page, limit, skip });

const total = await prisma.sale.count({
      where: {
        deletedAt: null,
      }
    });
    const sales = await prisma.sale.findMany({
      where: {
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        client: true,
        quote: {
          include: {
            client: true
          }
        },
        productionOrders: true
      }
    });

    const totalPages = Math.ceil(total / limit);

    console.log(`✅ [GET /api/sales] Página ${page}/${totalPages}: ${sales.length} de ${total} ventas`);

    res.json({
      ok: true,
      sales,
      pagination: {
        total,
        page,
        limit,
        totalPages,
        hasMore: page < totalPages,
        hasPrev: page > 1
      }
    });
  } catch (e) {
    console.error('❌ [GET /api/sales] Error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET SALES STATS
app.get('/api/sales/stats', async (req, res) => {
  try {
    const total = await prisma.sale.count();
    
    const salesData = await prisma.sale.findMany({
      select: { total: true, createdAt: true } // ✅ CORREGIDO
    });

    const totalAmount = salesData.reduce((sum, sale) => sum + parseFloat(sale.total), 0);

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonth = salesData.filter(sale => new Date(sale.createdAt) >= startOfMonth).length; // ✅ CORREGIDO

    const pendingOrders = await prisma.productionOrder.count({
      where: {
        status: {
          in: ['pending', 'in_progress']
        }
      }
    });

    res.json({
      ok: true,
      stats: {
        total,
        totalAmount,
        thisMonth,
        pendingOrders
      }
    });
  } catch (e) {
    console.error('❌ Error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// REPORTE ANUAL DE VENTAS (nuevo)
app.get('/api/sales/reporte-anual', requireAuth, async (req, res) => {
  try {
    const { generarReporteAnual } = require('./utils/reportes-service');
    const año = parseInt(req.query.año) || new Date().getFullYear();
    const userId = req.session?.userId || req.user?.id;

    console.log(`📊 [REPORTE ANUAL] Generando año ${año} para usuario ${userId}`);

    const filePath = await generarReporteAnual(año, userId);

    const nombreArchivo = `REPORTE_VENTAS_${año}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo}"`);

    const fs = require('fs');
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);

    fileStream.on('end', () => {
      console.log(`✅ [REPORTE ANUAL] Archivo enviado: ${nombreArchivo}`);
    });

    fileStream.on('error', (err) => {
      console.error('❌ [REPORTE ANUAL] Error enviando archivo:', err);
      res.status(500).json({ error: 'Error enviando archivo' });
    });

  } catch (e) {
    console.error('❌ [REPORTE ANUAL] Error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// EXPORT SALES TO EXCEL
app.get('/api/sales/export-excel', async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    
    const sales = await prisma.sale.findMany({
      orderBy: { createdAt: 'desc' }, // ✅ CORREGIDO
      include: {
        quote: {
          include: {
            client: true
          }
        }
      }
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Ventas');

    worksheet.columns = [
      { header: 'Folio Venta', key: 'folio', width: 15 },
      { header: 'Folio Cotización', key: 'quoteFolio', width: 15 },
      { header: 'Cliente', key: 'client', width: 30 },
      { header: 'Fecha', key: 'date', width: 15 },
      { header: 'Total', key: 'total', width: 15 },
      { header: 'Estado', key: 'status', width: 15 }
    ];

    sales.forEach(sale => {
      worksheet.addRow({
        folio: sale.folio,
        quoteFolio: sale.quote?.folio || 'N/A',
        client: sale.quote?.client?.name || 'N/A',
        date: new Date(sale.date || sale.createdAt).toLocaleDateString('es-MX'),
        total: `$${parseFloat(sale.total).toLocaleString('es-MX', {minimumFractionDigits: 2})}`,
        status: sale.status === 'completed' ? 'Completada' : sale.status === 'pending' ? 'Pendiente' : 'Cancelada'
      });
    });

    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF62E41' }
    };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=ventas.xlsx');

    await workbook.xlsx.write(res);
    res.end();

  } catch (e) {
    console.error('❌ Error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET SALE BY ID
app.get('/api/sales/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    
    // ✅ VALIDACIÓN: Verificar que el ID es válido
    if (isNaN(id) || !id) {
      console.error('❌ ID inválido recibido:', req.params.id);
      return res.status(400).json({ 
        ok: false, 
        error: 'ID de venta inválido' 
      });
    }

    console.log('🔍 Buscando venta con ID:', id);

    const sale = await prisma.sale.findUnique({
      where: { id },
      include: {
        client: true,
        quote: {
          include: {
            client: true,
            items: {
              include: {
                product: true
              }
            }
          }
        },
        productionOrders: true
      }
    });

    if (!sale) {
      return res.status(404).json({ ok: false, error: 'Venta no encontrada' });
    }

    res.json({ ok: true, sale });
  } catch (e) {
    console.error('❌ Error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ============================================
// RUTAS - ÓRDENES DE PRODUCCIÓN
// ============================================

// CREATE PRODUCTION ORDER
app.post('/api/production-orders', async (req, res) => {
  try {
    const { saleId, deliveryDate, priority, notes } = req.body;

    // Validar que la venta existe
    const sale = await prisma.sale.findUnique({
      where: { id: saleId },
      include: { productionOrders: true }  // ✅ CORREGIDO: plural
    });

    if (!sale) {
      return res.status(404).json({ ok: false, error: 'Venta no encontrada' });
    }

    // ✅ Verificar si ya tiene órdenes (puede tener múltiples)
    if (sale.productionOrders && sale.productionOrders.length > 0) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Esta venta ya tiene órdenes de producción asociadas' 
      });
    }

    // Generar folio
    const year = new Date().getFullYear();
    const lastOrder = await prisma.productionOrder.findFirst({
      where: {
        folio: {
          startsWith: `OP-${year}-`
        }
      },
      orderBy: { folio: 'desc' }
    });

    let nextNumber = 1;
    if (lastOrder) {
      const lastNumber = parseInt(lastOrder.folio.split('-')[2]);
      nextNumber = lastNumber + 1;
    }

    const folio = `OP-${year}-${String(nextNumber).padStart(3, '0')}`;

    // Crear orden
    const productionOrder = await prisma.productionOrder.create({
      data: {
        folio,
        saleId,
        status: 'pending',
        priority: priority || 'normal',
        dueDate: deliveryDate ? new Date(deliveryDate) : null,
        notes
      }
    });

    // Registrar actividad
    await prisma.activity.create({
      data: {
        type: 'PRODUCTION_ORDER_CREATED',
        description: `Orden de producción ${folio} creada`,
        saleId: sale.id,
        metadata: JSON.stringify({ saleId, priority })
      }
    });

    console.log('✅ Orden de producción creada:', folio);

    res.json({ ok: true, productionOrder });
  } catch (e) {
    console.error('❌ Error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// GET ALL PRODUCTION ORDERS (CON PAGINACIÓN)
// ============================================
app.get('/api/production-orders', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    console.log('📊 [GET /api/production-orders] Query params:', { page, limit, skip });

    const total = await prisma.productionOrder.count();
    const orders = await prisma.productionOrder.findMany({
      orderBy: { createdAt: 'desc' }, // ✅ CORREGIDO
      skip,
      take: limit,
      include: {
        sale: {
          include: {
            quote: {
              include: {
                client: true
              }
            }
          }
        }
      }
    });

    const totalPages = Math.ceil(total / limit);

    console.log(`✅ [GET /api/production-orders] Página ${page}/${totalPages}: ${orders.length} de ${total} órdenes`);

    res.json({
      ok: true,
      orders,
      pagination: {
        total,
        page,
        limit,
        totalPages,
        hasMore: page < totalPages,
        hasPrev: page > 1
      }
    });
  } catch (e) {
    console.error('❌ [GET /api/production-orders] Error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// GET PRODUCTION ORDERS STATS
// ============================================
app.get('/api/production-orders/stats', async (req, res) => {
  try {
    const total = await prisma.productionOrder.count();
    const pending = await prisma.productionOrder.count({ where: { status: 'pending' } });
    const inProgress = await prisma.productionOrder.count({ where: { status: 'in_progress' } });
    const completed = await prisma.productionOrder.count({ where: { status: 'completed' } });

    res.json({
      ok: true,
      stats: {
        total,
        pending,
        inProgress,
        completed
      }
    });
  } catch (e) {
    console.error('❌ Error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// EXPORT PRODUCTION ORDERS TO EXCEL
// ============================================
app.get('/api/production-orders/export-excel', async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    
    const orders = await prisma.productionOrder.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        sale: {
          include: {
            quote: {
              include: {
                client: true
              }
            }
          }
        }
      }
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Órdenes de Producción');

    worksheet.columns = [
      { header: 'Folio', key: 'folio', width: 15 },
      { header: 'Venta', key: 'sale', width: 15 },
      { header: 'Cliente', key: 'client', width: 30 },
      { header: 'Fecha Orden', key: 'orderDate', width: 15 },
      { header: 'Fecha Entrega', key: 'deliveryDate', width: 15 },
      { header: 'Prioridad', key: 'priority', width: 15 },
      { header: 'Estado', key: 'status', width: 15 }
    ];

    orders.forEach(order => {
      worksheet.addRow({
        folio: order.folio,
        sale: order.sale?.folio || 'N/A',
        client: order.sale?.quote?.client?.name || 'N/A',
        orderDate: new Date(order.orderDate).toLocaleDateString('es-MX'),
        deliveryDate: new Date(order.deliveryDate).toLocaleDateString('es-MX'),
        priority: order.priority === 'urgente' ? 'Urgente' : order.priority === 'alta' ? 'Alta' : 'Normal',
        status: order.status === 'completed' ? 'Completada' : 
                order.status === 'in_progress' ? 'En Proceso' :
                order.status === 'pending' ? 'Pendiente' : 'Cancelada'
      });
    });

    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF62E41' }
    };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=ordenes_produccion.xlsx');

    await workbook.xlsx.write(res);
    res.end();

  } catch (e) {
    console.error('❌ Error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ============================================
// GET PRODUCTION ORDER BY ID
// ============================================
app.get('/api/production-orders/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    
    // ✅ VALIDACIÓN
    if (isNaN(id) || !id) {
      console.error('❌ ID inválido recibido:', req.params.id);
      return res.status(400).json({ ok: false, error: 'ID de orden inválido' });
    }

    console.log('🔍 Buscando orden con ID:', id);

    const order = await prisma.productionOrder.findUnique({
      where: { id },
      include: {
        sale: {
          include: {
            quote: {
              include: {
                client: true
              }
            }
          }
        }
      }
    });

    if (!order) {
      return res.status(404).json({ ok: false, error: 'Orden no encontrada' });
    }

    res.json({ ok: true, order });
  } catch (e) {
    console.error('❌ Error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});



// ============================================
// UPDATE PRODUCTION ORDER STATUS
// ============================================
app.put('/api/production-orders/:id/status', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { status: newStatus } = req.body;

    // Validar ID
    if (isNaN(id) || !id) {
      return res.status(400).json({ ok: false, error: 'ID de orden inválido' });
    }

    // Validar nuevo estado
    const validStatuses = ['pending', 'in_progress', 'completed', 'cancelled'];
    if (!validStatuses.includes(newStatus)) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Estado inválido. Debe ser: pending, in_progress, completed, o cancelled' 
      });
    }

    // Obtener orden actual para guardar el estado anterior
    const currentOrder = await prisma.productionOrder.findUnique({
      where: { id }
    });

    if (!currentOrder) {
      return res.status(404).json({ ok: false, error: 'Orden no encontrada' });
    }

    // ✅ DEFINIR oldStatus ANTES de usarlo
    const oldStatus = currentOrder.status;

    // Actualizar estado
    const order = await prisma.productionOrder.update({
      where: { id },
      data: { 
        status: newStatus,
        // Si se marca como completada, guardar fecha
        completedAt: newStatus === 'completed' ? new Date() : currentOrder.completedAt
      },
      include: {
        sale: {
          include: {
            quote: {
              include: {
                client: true
              }
            }
          }
        }
      }
    });

    // Registrar actividad (si la orden tiene saleId)
    if (order.saleId) {
      await prisma.activity.create({
        data: {
          type: 'PRODUCTION_ORDER_STATUS_UPDATED',
          saleId: order.saleId,
          description: `Estado de orden ${order.folio} actualizado de ${oldStatus} a ${newStatus}`,
          metadata: JSON.stringify({ 
            orderId: order.id,
            orderFolio: order.folio,
            oldStatus, 
            newStatus 
          })
        }
      });
    }

    console.log(`✅ Orden ${order.folio} actualizada: ${oldStatus} → ${newStatus}`);

    res.json({ ok: true, order });
  } catch (e) {
    console.error('❌ Error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ============================================
// QUOTES API (Prisma)
// ============================================

app.get('/api/quotes', async (req, res) => {
  try {
    const { search, status, dateFrom, dateTo } = req.query;
    
    const where = {
      deletedAt: null  // ⭐ SOLO MOSTRAR COTIZACIONES NO ELIMINADAS
    };
    
    // Filtro de búsqueda
    if (search) {
      where.OR = [
        { folio: { contains: search, mode: 'insensitive' } },
        { client: { name: { contains: search, mode: 'insensitive' } } },
        { client: { company: { contains: search, mode: 'insensitive' } } }
      ];
    }
    
    // Filtro de estado
    if (status) where.status = status;

    // Filtro de tipo de caso
    if (req.query.tipoCaso) where.tipoCaso = req.query.tipoCaso;
    
    // Filtro de fecha
    if (dateFrom || dateTo) {
      where.date = {};
      if (dateFrom) where.date.gte = new Date(dateFrom);
      if (dateTo) {
        const toDate = new Date(dateTo);
        toDate.setHours(23, 59, 59, 999);
        where.date.lte = toDate;
      }
    }
    
    const quotes = await prisma.quote.findMany({
      where,
      include: { client: true, items: { include: { product: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500
    });
    
    res.json({ ok: true, quotes });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// GENERAR FOLIO CONSECUTIVO
// ============================================
app.get('/api/quotes/siguiente-folio', requireAuth, async (req, res) => {
  try {
    const date   = new Date();
    const anio2  = String(date.getFullYear()).slice(-2); // "26"
    const prefijo = `COT-${anio2}-`;

    // Leer folio inicial desde configuración
    const configInicio = await prisma.config.findUnique({
      where: { clave: 'folio_inicial_cotizacion' }
    });
    const folioInicial = configInicio ? parseInt(configInicio.valor) : 1;

    // Buscar la última cotización del año actual con nuevo formato
    const ultimaCot = await prisma.quote.findFirst({
      where: { folio: { startsWith: prefijo } },
      orderBy: { folio: 'desc' }
    });

    let siguiente = folioInicial;
    if (ultimaCot) {
      const partes   = ultimaCot.folio.split('-');
      const ultimoNum = parseInt(partes[partes.length - 1]);
      if (!isNaN(ultimoNum) && ultimoNum >= folioInicial) {
        siguiente = ultimoNum + 1;
      }
    }

    const folio = `${prefijo}${String(siguiente).padStart(4, '0')}`;
    res.json({ folio });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/quotes/:id', async (req, res) => {
  try {
    const quote = await prisma.quote.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        client: true,
        items: {
          include: { product: true }
        }
      }
    });
    if (!quote) return res.status(404).json({ ok: false, error: 'Cotización no encontrada' });
    res.json({ ok: true, quote });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/quotes', requireAuth, async (req, res) => {
  try {
    // ⭐ EXTRAER clientId DEL BODY
    const { 
      folio, 
      template, 
      clientId,  // ⭐ AGREGAR AQUÍ
      fields, 
      tiempoEntrega, 
      formaPago, 
      items, 
      subtotal, 
      descuento, 
      impuestos, 
      total, 
      precio_neto_mxn, 
      exchangeRate,
      tipoCaso, 
      anticipoMonto, 
      reparacionMonto, 
      mantenimientoMonto,
      notasCaso,
      country,
      esExtranjero,
    } = req.body;
    
    console.log('💾 [POST /api/quotes] Datos recibidos:', {
      folio,
      clientId,
      subtotal,
      total,
      items: items?.length,
      tipoCaso,
      anticipoMonto,
      reparacionMonto, 
      mantenimientoMonto,
      notasCaso,
      country,
      esExtranjero,
    });
    
    if (!folio) return res.status(400).json({ ok: false, error: 'El folio es requerido' });
    if (!items || items.length === 0) return res.status(400).json({ ok: false, error: 'Debe agregar al menos un item' });
    
    const existing = await prisma.quote.findUnique({ where: { folio } });
    if (existing) return res.status(400).json({ ok: false, error: 'El folio ya existe' });
    
    // ⭐ USAR clientId SI VIENE EN EL BODY, SI NO, BUSCAR/CREAR
    let finalClientId = clientId || null;  // ⭐ USAR EL clientId ENVIADO
    
    // Solo crear/buscar cliente si NO viene clientId pero sí viene fields.nombre
    if (!finalClientId && fields && fields.nombre) {
      console.log('  ℹ️ No hay clientId, buscando/creando cliente por nombre...');
      
      const clientData = {
        name: fields.nombre || fields.senor || 'Sin nombre',
        company: fields.empresa || fields.cliente || null,
        phone: fields.numero || null,
        email: fields.correo || null,
        estado: fields.estado || null
      };
      
      const existingClient = await prisma.client.findFirst({
        where: { name: clientData.name }
      });
      
      if (existingClient) {
        finalClientId = existingClient.id;
        console.log('  ✅ Cliente existente encontrado:', existingClient.id);
      } else {
        const newClient = await prisma.client.create({ data: clientData });
        finalClientId = newClient.id;
        console.log('  ✅ Cliente nuevo creado:', newClient.id);
      }
    }
    
    console.log('  📌 clientId final que se guardará:', finalClientId);
    
    // Convertir valores a números antes de guardar
    const subtotalNum = parseFloat(subtotal) || 0;
    const descuentoNum = parseFloat(descuento) || 0;
    const impuestosNum = parseFloat(impuestos) || 0;
    const totalNum = parseFloat(total) || 0;
    const netMxnNum = precio_neto_mxn ? parseFloat(precio_neto_mxn) : null;
    const exchangeRateNum = exchangeRate ? parseFloat(exchangeRate) : null;
    
    console.log('💾 Guardando cotización con valores:', {
      subtotal: subtotalNum,
      descuento: descuentoNum,
      impuestos: impuestosNum,
      total: totalNum,
      netMxn: netMxnNum,
      clientId: finalClientId  // ⭐ VERIFICAR QUE SE GUARDA
    });
    
    const quote = await prisma.quote.create({
      data: {
        folio,
        date: fields?.fecha ? new Date(fields.fecha + 'T12:00:00') : new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' })),
        clientId: finalClientId,  // ⭐ USAR finalClientId EN LUGAR DE clientId
        subtotal: subtotalNum,
        discount: descuentoNum,
        tax: impuestosNum,
        total: totalNum,
        netMxn: netMxnNum,
        exchangeRate: exchangeRateNum,
        tipoCaso:  tipoCaso  || 'venta',
        anticipoMonto: anticipoMonto ? parseFloat(anticipoMonto) : null,
        reparacionMonto: tipoCaso === 'reparacion' ? parseFloat(reparacionMonto) || null : null,
        mantenimientoMonto: tipoCaso === 'mantenimiento' ? parseFloat(mantenimientoMonto) || null : null,
        notasCaso: notasCaso || null,
        country:      country      || 'MX',
        esExtranjero: esExtranjero || false,
        tiempoEntrega: tiempoEntrega || null,
        formaPago: formaPago || null,
        template: template || null,
        currency: 'USD',
        status: 'vigente',
        createdById: req.user?.id || null, 
        items: {
          create: items.map(item => ({
            modelo: item.modelo || '',
            descripcion: item.descripcion || '',
            unitPrice: parseFloat(item.precio) || 0,
            qty: parseInt(item.cant) || 1,
            subtotal: parseFloat(item.subtotal) || 0,
            categoryType: item.categoryType || null,
            providerCost: item.providerCost ? parseFloat(item.providerCost) : null,
          }))
        }
      },
      include: {
        client: true,
        items: true
      }
    });
    
    console.log('✅ Cotización creada:', quote.id, '- Cliente:', quote.clientId);
    res.json({ ok: true, quote, id: quote.id });
  } catch (e) {
    console.error('❌ Error creando cotización:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// ENDPOINT MEJORADO PARA EDICIÓN DE COTIZACIONES
// Reemplaza el endpoint PUT /api/quotes/:id existente en tu server.js con este código
// ============================================

app.put('/api/quotes/:id', async (req, res) => {
  try {
    const quoteId = parseInt(req.params.id);
    const { 
      folio, 
      template, 
      fecha,
      nombre,
      empresa,
      estado,
      correo,
      numero,
      subtotal, 
      descuento, 
      impuestos, 
      total, 
      precio_neto_mxn, 
      exchangeRate, 
      status, 
      tiempoEntrega,
      formaPago,
      items 
    } = req.body;
    
    // 📝 Obtener cotización original para comparar cambios
    const oldQuote = await prisma.quote.findUnique({
      where: { id: quoteId },
      include: { client: true, items: true }
    });
    
    if (!oldQuote) {
      return res.status(404).json({ ok: false, error: 'Cotización no encontrada' });
    }
    
    // 🔍 Validaciones
    if (!items || items.length === 0) {
      return res.status(400).json({ ok: false, error: 'Debe haber al menos un item' });
    }
    
    // 👤 Actualizar o crear cliente si cambió la información
    let clientId = oldQuote.clientId;
    
    if (nombre || empresa || correo || numero || estado) {
      const clientData = {
        name: nombre || oldQuote.client?.name || 'Sin nombre',
        company: empresa || oldQuote.client?.company || null,
        phone: numero || oldQuote.client?.phone || null,
        email: correo || oldQuote.client?.email || null,
        estado: estado || oldQuote.client?.estado || null
      };
      
      if (clientId) {
        // Actualizar cliente existente
        await prisma.client.update({
          where: { id: clientId },
          data: clientData
        });
      } else {
        // Crear nuevo cliente
        const newClient = await prisma.client.create({ data: clientData });
        clientId = newClient.id;
      }
    }
    
    // 🗑️ Eliminar items antiguos
    await prisma.quoteItem.deleteMany({
      where: { quoteId }
    });
    
    // 💾 Actualizar cotización con nuevos datos
    const subtotalNum = parseFloat(subtotal) || 0;
    const descuentoNum = parseFloat(descuento) || 0;
    const impuestosNum = parseFloat(impuestos) || 0;
    const totalNum = parseFloat(total) || 0;
    const netMxnNum = precio_neto_mxn ? parseFloat(precio_neto_mxn) : null;
    const exchangeRateNum = exchangeRate ? parseFloat(exchangeRate) : null;
    
    console.log('💾 Actualizando cotización con valores:', {
      subtotal: subtotalNum,
      descuento: descuentoNum,
      impuestos: impuestosNum,
      total: totalNum,
      netMxn: netMxnNum,
      exchangeRate: exchangeRateNum
    });
    
    const quote = await prisma.quote.update({
      where: { id: quoteId },
      data: {
        folio: folio || oldQuote.folio,
        date: fecha ? new Date(fecha + 'T12:00:00') : oldQuote.date,
        clientId,
        template: template || oldQuote.template,
        subtotal: subtotalNum,
        discount: descuentoNum,
        tax: impuestosNum,
        total: totalNum,
        netMxn: netMxnNum,
        exchangeRate: exchangeRateNum,
        status: status || oldQuote.status,
        tiempoEntrega: tiempoEntrega !== undefined ? tiempoEntrega : oldQuote.tiempoEntrega,
        formaPago: formaPago !== undefined ? formaPago : oldQuote.formaPago, 
        items: {
          create: items.map(item => ({
            modelo: item.modelo || '',
            descripcion: item.descripcion || '',
            unitPrice: parseFloat(item.precio) || 0,
            qty: parseInt(item.cant) || 1,
            subtotal: parseFloat(item.subtotal) || 0,
            categoryType: item.categoryType || null,
            providerCost: item.providerCost ? parseFloat(item.providerCost) : null,
          }))
        }
      },
      include: {
        client: true,
        items: true
      }
    });
    
    // 📝 Registrar actividad de edición
    const changes = [];
    if (oldQuote.exchangeRate !== exchangeRateNum) {
      changes.push(`Tipo de cambio: ${oldQuote.exchangeRate?.toFixed(4)} → ${exchangeRateNum?.toFixed(4)}`);
    }
    if (oldQuote.total !== totalNum) {
      changes.push(`Total: $${oldQuote.total?.toFixed(2)} → $${totalNum.toFixed(2)}`);
    }
    if (oldQuote.items.length !== items.length) {
      changes.push(`Items: ${oldQuote.items.length} → ${items.length}`);
    }
    
    const changeDescription = changes.length > 0 
      ? `Cotización editada. Cambios: ${changes.join(', ')}`
      : 'Cotización editada';
    
    await logActivity({
      type: 'quote_edited',
      description: changeDescription,
      quoteId: quote.id,
      metadata: {
        folio: quote.folio,
        oldExchangeRate: oldQuote.exchangeRate,
        newExchangeRate: exchangeRateNum,
        oldTotal: oldQuote.total,
        newTotal: totalNum
      }
    });
    
    console.log('✅ Cotización actualizada:', quote.folio);
    res.json({ ok: true, quote });
    
  } catch (e) {
    console.error('❌ Error actualizando cotización:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// SOFT-DELETE DE COTIZACIONES (PAPELERA)
// ============================================
app.delete('/api/quotes/:id', async (req, res) => {
  try {
    const quoteId = parseInt(req.params.id);
    
    // Soft-delete: marcar como eliminada en lugar de borrar
    const quote = await prisma.quote.update({
      where: { id: quoteId },
      data: { deletedAt: new Date() }
    });
    
    console.log('🗑️ Cotización movida a papelera:', quote.folio);
    
    res.json({ ok: true, message: 'Cotización movida a papelera' });
  } catch (e) {
    console.error('❌ Error eliminando cotización:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// GENERAR OP CON DATOS DEL FORMULARIO
// ============================================
app.post('/api/quotes/:id/generar-op', requireAuth, async (req, res) => {
  const { id } = req.params;
  const {
    folio, modelo, descripcion, cant,
    esTransformador,
    voltajeMinEntrada, voltajeMaxEntrada,
    voltajeEntrada, voltajeSalida,
    numeroSerie, fechaSalida, adicionales, observaciones
  } = req.body;

  try {
    const quote = await prisma.quote.findUnique({
      where: { id: parseInt(id) },
      include: { client: true }
    });

    if (!quote) return res.status(404).json({ error: 'Cotización no encontrada' });

    // ⭐ Buscar la ProductionOrder asociada a este modelo para guardar los datos
    const sale = await prisma.sale.findFirst({
      where: { quoteId: parseInt(id) },
      include: { productionOrders: true }
    });

    const produccionExistente = sale?.productionOrders?.find(po =>
      po.productModel === modelo
    );

    if (produccionExistente) {
      await prisma.productionOrder.update({
        where: { id: produccionExistente.id },
        data: {
          esTransformador:   esTransformador || false,
          voltajeMinEntrada: voltajeMinEntrada || null,
          voltajeMaxEntrada: voltajeMaxEntrada || null,
          voltajeEntrada:    voltajeEntrada || null,
          voltajeSalida:     voltajeSalida || null,
          adicionales:       adicionales || null,
          observaciones:     observaciones || null,
        }
      });
    }

    const mexicoDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });

    const orderData = {
      folio: folio || quote.folio,
      createdAt: mexicoDate + 'T12:00:00',
      clientName: quote.client?.name || 'Cliente',
      clientCompany: quote.client?.company || '',
      modelo: modelo || '',
      descripcion: descripcion || '',
      cant: cant || 1,
      esTransformador: esTransformador || false,
      voltajeMinEntrada: voltajeMinEntrada || '',
      voltajeMaxEntrada: voltajeMaxEntrada || '',
      voltajeEntrada: voltajeEntrada || '',
      voltajeSalida: voltajeSalida || '',
      numeroSerie: numeroSerie || '',
      fechaSalida: fechaSalida || '',
      adicionales: adicionales || '',
      observaciones: observaciones || '',
    };

    const templatePath = path.resolve(__dirname, 'FORMATO_ORDEN_DE_PRODUCCION.xlsx');
    const outputDir = path.resolve(__dirname, 'temp', 'production-orders');
    const outputFilename = `ORDEN_PRODUCCION_${folio}_${modelo}_${Date.now()}.xlsx`;
    const outputPath = path.resolve(outputDir, outputFilename);

    if (!fs.existsSync(templatePath)) {
      return res.status(500).json({ error: 'Template de Orden de Producción no encontrado' });
    }

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const pythonScript = path.resolve(__dirname, 'scripts', 'generate-production-order.py');
    const { execFile } = require('child_process');

    // ⭐ Limpiar descripcion para evitar saltos de línea que rompen el comando
    orderData.descripcion = (orderData.descripcion || '').replace(/\n/g, ' ').replace(/\r/g, '');

// ⭐ Escribir datos en archivo temporal para evitar problemas con caracteres especiales
    const tempJsonPath = outputPath + '.json';
    fs.writeFileSync(tempJsonPath, JSON.stringify(orderData), 'utf8');

    await new Promise((resolve, reject) => {
      execFile(
        'python3',
        [pythonScript, tempJsonPath, templatePath, outputPath],
        { timeout: 60000 },
        (err, stdout, stderr) => {
          if (stdout) console.log(`🐍 [PYTHON] ${stdout.trim()}`);
          if (stderr) console.log(`🐍 [PYTHON STDERR] ${stderr.trim()}`);
          try { fs.unlinkSync(tempJsonPath); } catch(e) {}
          if (err) reject(new Error(`STDERR: ${stderr} | STDOUT: ${stdout} | MSG: ${err.message}`));
          else resolve();
        }
      );
    });

    if (!fs.existsSync(outputPath)) {
      throw new Error('Archivo Excel no se generó correctamente');
    }

    res.download(outputPath, outputFilename, (err) => {
      try { fs.unlinkSync(outputPath); } catch(e) {}
    });

  } catch(e) {
    console.error('❌ [GENERAR-OP] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// FUNCIÓN: GENERAR FOLIO DE VENTA
// ============================================
async function generarFolioVenta() {
  const date   = new Date();
  const anio2  = String(date.getFullYear()).slice(-2);
  const prefijo = `VTA-${anio2}-`;

  const configInicio = await prisma.config.findUnique({
    where: { clave: 'folio_inicial_venta' }
  });
  const folioInicial = configInicio ? parseInt(configInicio.valor) : 1;

  const ultimaVenta = await prisma.sale.findFirst({
    where: { folio: { startsWith: prefijo } },
    orderBy: { folio: 'desc' }
  });

  let siguiente = folioInicial;
  if (ultimaVenta) {
    const partes    = ultimaVenta.folio.split('-');
    const ultimoNum = parseInt(partes[partes.length - 1]);
    if (!isNaN(ultimoNum) && ultimoNum >= folioInicial) {
      siguiente = ultimoNum + 1;
    }
  }

  return `${prefijo}${String(siguiente).padStart(4, '0')}`;
}

// ============================================
// GENERAR ORDEN DE PRODUCCIÓN DESDE COTIZACIÓN
// VERSIÓN FINAL - RUTAS CON ESPACIOS EN WINDOWS
// ============================================
// Reemplaza el endpoint existente en tu server.js
// ============================================

app.post('/api/quotes/:id/generate-production-order', requireAuth, async (req, res) => {
  const { id } = req.params;
  const userId = req.user?.id;

  console.log('📋 [ORDEN PRODUCCIÓN] Iniciando para cotización:', id);
  console.log('👤 [ORDEN PRODUCCIÓN] Usuario autenticado:', userId);

  if (!userId) {
    console.error('❌ [ORDEN PRODUCCIÓN] No autenticado');
    return res.status(401).json({ error: 'No autenticado' });
  }

  try {
    // 1. Obtener la cotización con todos sus datos
    const quote = await prisma.quote.findUnique({
      where: { id: parseInt(id) },
      include: {
        client: true,
        items: true
      }
    });

    if (!quote) {
      console.error(`❌ [ORDEN PRODUCCIÓN] Cotización ${id} no encontrada`);
      return res.status(404).json({ error: 'Cotización no encontrada' });
    }

    console.log(`✅ [ORDEN PRODUCCIÓN] Cotización encontrada: ${quote.folio}`);

    // 2. Verificar que la cotización esté vigente
    if (quote.status !== 'vigente') {
      console.warn(`⚠️ [ORDEN PRODUCCIÓN] Cotización ${quote.folio} no está vigente (${quote.status})`);
      return res.status(400).json({ 
        error: 'Solo se pueden convertir cotizaciones vigentes a venta',
        currentStatus: quote.status
      });
    }

    console.log(`🔄 [ORDEN PRODUCCIÓN] Convirtiendo cotización ${quote.folio} a venta...`);

    // 3. Convertir cotización a venta
    const { saleDate } = req.body;
    const fechaVenta = saleDate ? new Date(saleDate) : new Date();
    console.log('🔍 DEBUG quote.items:', JSON.stringify(quote.items.map(i => ({
      modelo: i.modelo,
      categoryType: i.categoryType,
      providerCost: i.providerCost
    })), null, 2));
    const folioVenta = await generarFolioVenta();
    const sale = await prisma.sale.create({
      data: {
        folio: folioVenta,
        date: fechaVenta,
        quote: {
          connect: { id: quote.id }
        },
        client: quote.clientId ? { connect: { id: quote.clientId } } : undefined,
        createdBy: { connect: { id: userId } },
        items: {
          create: quote.items.map(item => ({
            modelo: item.modelo,
            descripcion: item.descripcion || '',
            unitPrice: item.unitPrice,
            qty: item.qty,
            subtotal: item.subtotal,
            categoryType: item.categoryType || null,
            providerCost: item.providerCost || null,
          }))
        },
        subtotal: quote.subtotal,
        discount: quote.discount || 0,
        tax: quote.tax || 0,
        total: quote.total,
        currency: quote.currency || 'USD',
        exchangeRate: quote.exchangeRate || 18.0,
        netMxn: quote.netMxn || 0,
        paymentStatus: 'pending',
        deliveryStatus: 'pending',
        template: quote.template || null,
        tiempoEntrega: quote.tiempoEntrega || null,
        formaPago: quote.formaPago || null,
        // ⭐ NUEVO: Transferir tipo de caso desde la cotización
        tipoCaso: quote.tipoCaso || 'venta',
        categoryType:  quote.categoryType  || null,   // ⭐ NUEVO
        providerCost:  quote.providerCost  || null,   // ⭐ NUEVO
        country: quote.country || 'MX',
        reparacionMonto: quote.reparacionMonto || null,
        mantenimientoMonto: quote.mantenimientoMonto || null,
        anticipoMonto: quote.anticipoMonto || null,
        notasCaso: quote.notasCaso || null,
      }
    });

    console.log(`✅ [ORDEN PRODUCCIÓN] Venta creada: ID ${sale.id}`);

    // 4. Actualizar estado de la cotización
    await prisma.quote.update({
      where: { id: parseInt(id) },
      data: { 
        status: 'convertida',
        convertedToSaleAt: new Date()
      }
    });

    console.log(`✅ [ORDEN PRODUCCIÓN] Cotización actualizada a 'convertida'`);

    // 5. Crear órdenes de producción (una por cada item)
    const productionOrders = [];
    
    for (const item of quote.items) {
      const productionOrder = await prisma.productionOrder.create({
        data: {
          orderNumber: `OP-${quote.folio}-${item.modelo.substring(0, 10).replace(/\s/g, '')}`,
          sale: { connect: { id: sale.id } },
          clientName: quote.client?.name || 'Cliente',
          productModel: item.modelo,
          productDescription: item.descripcion || '',
          quantity: item.qty,
          status: 'pending',
          createdBy: { connect: { id: userId } }
        }
      });
      
      productionOrders.push(productionOrder);
      console.log(`✅ [ORDEN PRODUCCIÓN] Orden creada: ${productionOrder.orderNumber}`);
    }

    // 6. Registrar actividad
    await logActivity({
      type: 'quote_converted',
      description: `Cotización ${quote.folio} convertida a venta y generadas ${productionOrders.length} orden(es) de producción`,
      quoteId: quote.id,
      metadata: {
        folio: quote.folio,
        saleId: sale.id,
        productionOrderIds: productionOrders.map(po => po.id)
      }
    });

    console.log(`📝 [ORDEN PRODUCCIÓN] Actividad registrada`);

    // ⭐ Si soloConvertir=true, devolver JSON con items y terminar
    if (req.body.soloConvertir) {
      return res.json({
        ok: true,
        saleId: sale.id,
        folio: quote.folio,
        items: quote.items.map(item => ({
          modelo: item.modelo,
          descripcion: item.descripcion || '',
          cant: item.qty,
          categoryType: item.categoryType || null
        }))
      });
    }

    // 7. Generar archivo Excel de Orden de Producción
    console.log(`📊 [ORDEN PRODUCCIÓN] Generando Excel...`);

    // Preparar datos para el script Python
    const mexicoDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    const orderData = {
      folio: quote.folio,
      quoteFollio: quote.folio,
      createdAt: mexicoDate + 'T12:00:00',
      deliveryDate: null,
      clientName: quote.client?.name || 'Cliente',
      clientCompany: quote.client?.company || '',
      notes: `Cotización: ${quote.folio}\nForma de Pago: ${quote.formaPago || 'N/A'}`,
      priority: 'normal',
      additionalNotes: quote.tiempoEntrega || '',
      items: quote.items.map(item => ({
        modelo: item.modelo,
        descripcion: item.descripcion || '',
        cant: item.qty
      }))
    };

    // Rutas
    const templatePath = path.resolve(__dirname, 'FORMATO_ORDEN_DE_PRODUCCION.xlsx');
    const outputDir = path.resolve(__dirname, 'temp', 'production-orders');
    const outputFilename = `ORDEN_PRODUCCION_${quote.folio}_${Date.now()}.xlsx`;
    const outputPath = path.resolve(outputDir, outputFilename);

    console.log(`📂 [ORDEN PRODUCCIÓN] Template: ${templatePath}`);
    console.log(`📂 [ORDEN PRODUCCIÓN] Output: ${outputPath}`);

    // Verificar template
    if (!fs.existsSync(templatePath)) {
      console.error(`❌ [ORDEN PRODUCCIÓN] Template no encontrado`);
      return res.status(500).json({ 
        error: 'Template de Orden de Producción no encontrado',
        path: templatePath
      });
    }

    console.log(`✅ [ORDEN PRODUCCIÓN] Template encontrado`);

    // Crear directorio
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
      console.log(`📁 [ORDEN PRODUCCIÓN] Directorio de salida creado: ${outputDir}`);
    }

    // Ejecutar Python
    const pythonScript = path.resolve(__dirname, 'scripts', 'generate-production-order.py');
    
    console.log(`🐍 [ORDEN PRODUCCIÓN] Ejecutando Python: ${pythonScript}`);

    // ⭐ SOLUCIÓN FINAL: Usar formato de comando completo en una sola string
    // Esto evita problemas con espacios en rutas en Windows
    const { execFile } = require('child_process');

    await new Promise((resolve, reject) => {
      execFile(
        'python3',
        [pythonScript, JSON.stringify(orderData), templatePath, outputPath],
        { timeout: 15000 },
        (err, stdout, stderr) => {
          if (stdout) console.log(`🐍 [PYTHON] ${stdout.trim()}`);
          if (stderr) console.log(`🐍 [PYTHON STDERR] ${stderr.trim()}`);
          if (err) reject(new Error(stderr || err.message));
          else resolve();
        }
      );
    });
    console.log(`✅ [ORDEN PRODUCCIÓN] Excel generado exitosamente`);

    // 8. Verificar que el archivo existe
    if (!fs.existsSync(outputPath)) {
      console.error(`❌ [ORDEN PRODUCCIÓN] Archivo no encontrado después de generación: ${outputPath}`);
      throw new Error('Archivo Excel no se generó correctamente');
    }

    const stats = fs.statSync(outputPath);
    console.log(`📊 [ORDEN PRODUCCIÓN] Archivo generado: ${stats.size} bytes`);

    // 9. Enviar el archivo generado
    console.log(`📤 [ORDEN PRODUCCIÓN] Enviando archivo al cliente...`);

    res.download(outputPath, outputFilename, (err) => {
      if (err) {
        console.error('❌ [ORDEN PRODUCCIÓN] Error enviando archivo:', err);
      } else {
        console.log(`✅ [ORDEN PRODUCCIÓN] Archivo enviado exitosamente`);
      }
      
      // Limpiar archivo temporal
      try {
        fs.unlinkSync(outputPath);
        console.log(`🗑️ [ORDEN PRODUCCIÓN] Archivo temporal eliminado`);
      } catch (e) {
        console.error('⚠️ [ORDEN PRODUCCIÓN] Error eliminando temporal:', e);
      }
    });

  } catch (error) {
    console.error('❌ [ORDEN PRODUCCIÓN] Error:', error);
    res.status(500).json({ 
      error: 'Error generando orden de producción: ' + error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// ============================================
// FUNCIONES AUXILIARES
// ============================================

function extractCapacity(text) {
  if (!text) return '';
  const match = text.match(/(\d+)\s*(kva|kw|va|w)/i);
  return match ? match[0].toUpperCase() : '';
}

function determineTipo(modelo, descripcion) {
  const text = `${modelo || ''} ${descripcion || ''}`.toLowerCase();
  
  if (text.includes('3f') || text.includes('trifas') || text.includes('3 fases')) {
    return '3F';
  } else if (text.includes('2fn') || text.includes('bifasico neutro')) {
    return '2FN';
  } else if (text.includes('2f') || text.includes('bifas') || text.includes('2 fases')) {
    return '2F';
  } else if (text.includes('1f') || text.includes('monofas') || text.includes('1 fase')) {
    return '1F';
  }
  
  return '1F';
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// ============================================
// ENDPOINTS DE PAPELERA
// ============================================

// 1. LISTAR COTIZACIONES ELIMINADAS (PAPELERA)
app.get('/api/trash/quotations', async (req, res) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const skip = (page - 1) * limit;

    // Construir filtro
    const where = {
      deletedAt: { not: null }, // Solo cotizaciones eliminadas
      OR: search ? [
        { folio: { contains: search, mode: 'insensitive' } },
        { client: { name: { contains: search, mode: 'insensitive' } } },
        { client: { company: { contains: search, mode: 'insensitive' } } }
      ] : undefined
    };

    // Contar total
    const total = await prisma.quote.count({ where });

    // Obtener cotizaciones eliminadas
    const quotations = await prisma.quote.findMany({
      where,
      include: {
        client: true,
        items: {
          include: {
            product: true
          }
        }
      },
      orderBy: { deletedAt: 'desc' },
      skip: parseInt(skip),
      take: parseInt(limit)
    });

    res.json({
      ok: true,
      quotations,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / limit)
      }
    });

  } catch (e) {
    console.error('❌ Error obteniendo papelera:', e);
    res.status(500).json({
      ok: false,
      error: 'Error obteniendo cotizaciones eliminadas'
    });
  }
});

// 2. RESTAURAR COTIZACIÓN
app.post('/api/trash/quotations/:id/restore', async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar que existe y está eliminada
    const quotation = await prisma.quote.findFirst({
      where: {
        id: parseInt(id),
        deletedAt: { not: null }
      }
    });

    if (!quotation) {
      return res.status(404).json({
        ok: false,
        error: 'Cotización no encontrada en papelera'
      });
    }

    // Restaurar (quitar deletedAt)
    const restored = await prisma.quote.update({
      where: { id: parseInt(id) },
      data: { deletedAt: null },
      include: {
        client: true,
        items: {
          include: {
            product: true
          }
        }
      }
    });

    console.log(`♻️ Cotización restaurada: ${restored.folio}`);

    res.json({
      ok: true,
      message: 'Cotización restaurada exitosamente',
      quotation: restored
    });

  } catch (e) {
    console.error('❌ Error restaurando cotización:', e);
    res.status(500).json({
      ok: false,
      error: 'Error restaurando cotización'
    });
  }
});

// 3. ELIMINAR PERMANENTEMENTE
app.delete('/api/trash/quotations/:id/permanent', async (req, res) => {
  try {
    const { id } = req.params;
    const quoteId = parseInt(id);

    // Verificar que existe y está eliminada
    const quotation = await prisma.quote.findFirst({
      where: {
        id: quoteId,
        deletedAt: { not: null }
      },
      include: { items: true }
    });

    if (!quotation) {
      return res.status(404).json({
        ok: false,
        error: 'Cotización no encontrada en papelera'
      });
    }

    await prisma.$transaction(async (tx) => {
      // 1. Buscar si tiene venta asociada
      const sale = await tx.sale.findUnique({
        where: { quoteId },
        select: { id: true }
      });

      if (sale) {
        // 2. Eliminar comisiones de la venta
        await tx.commission.deleteMany({ where: { saleId: sale.id } });

        // 3. Eliminar actividades de la venta
        await tx.activity.deleteMany({ where: { saleId: sale.id } });

        // 4. Eliminar órdenes de producción
        await tx.productionOrder.deleteMany({ where: { saleId: sale.id } });

        // 5. Eliminar items de la venta
        await tx.saleItem.deleteMany({ where: { saleId: sale.id } });

        // 6. Eliminar la venta
        await tx.sale.delete({ where: { id: sale.id } });
      }

      // 7. Eliminar actividades de la cotización
      await tx.activity.deleteMany({ where: { quoteId } });

      // 8. Eliminar items de la cotización
      await tx.quoteItem.deleteMany({ where: { quoteId } });

      // 9. Eliminar la cotización
      await tx.quote.delete({ where: { id: quoteId } });
    });

    // Eliminar PDF fuera de la transacción
    const pdfPath = path.join(ORDERS_DIR, `${quotation.folio}.pdf`);
    if (fs.existsSync(pdfPath)) {
      fs.unlinkSync(pdfPath);
      console.log(`🗑️ PDF eliminado: ${quotation.folio}.pdf`);
    }

    console.log(`🗑️ Cotización eliminada permanentemente: ${quotation.folio}`);

    res.json({
      ok: true,
      message: 'Cotización eliminada permanentemente'
    });

  } catch (e) {
    console.error('❌ Error eliminando permanentemente:', e);
    res.status(500).json({
      ok: false,
      error: 'Error eliminando cotización permanentemente'
    });
  }
});

// 4. VACIAR PAPELERA (ELIMINAR TODO)
app.delete('/api/trash/quotations/empty', async (req, res) => {
  try {
    // Obtener todas las cotizaciones eliminadas
    const deletedQuotations = await prisma.quote.findMany({
      where: { deletedAt: { not: null } },
      select: { id: true, folio: true }
    });

    const quotationIds = deletedQuotations.map(q => q.id);

    if (quotationIds.length === 0) {
      return res.json({ ok: true, message: 'La papelera ya estaba vacía', count: 0 });
    }

    // Eliminar en orden para respetar las llaves foráneas
    await prisma.$transaction(async (tx) => {

      // 1. Obtener ventas asociadas a estas cotizaciones
      const sales = await tx.sale.findMany({
        where: { quoteId: { in: quotationIds } },
        select: { id: true }
      });
      const saleIds = sales.map(s => s.id);

      if (saleIds.length > 0) {
        // 2. Eliminar comisiones de esas ventas
        await tx.commission.deleteMany({
          where: { saleId: { in: saleIds } }
        });

        // 3. Eliminar actividades de esas ventas
        await tx.activity.deleteMany({
          where: { saleId: { in: saleIds } }
        });

        // 4. Eliminar órdenes de producción de esas ventas
        await tx.productionOrder.deleteMany({
          where: { saleId: { in: saleIds } }
        });

        // 5. Eliminar items de esas ventas
        await tx.saleItem.deleteMany({
          where: { saleId: { in: saleIds } }
        });

        // 6. Eliminar las ventas
        await tx.sale.deleteMany({
          where: { id: { in: saleIds } }
        });
      }

      // 7. Eliminar actividades de las cotizaciones
      await tx.activity.deleteMany({
        where: { quoteId: { in: quotationIds } }
      });

      // 8. Eliminar items de las cotizaciones
      await tx.quoteItem.deleteMany({
        where: { quoteId: { in: quotationIds } }
      });

      // 9. Finalmente eliminar las cotizaciones
      await tx.quote.deleteMany({
        where: { id: { in: quotationIds } }
      });
    });

    // Eliminar PDFs fuera de la transacción
    deletedQuotations.forEach(q => {
      const pdfPath = path.join(ORDERS_DIR, `${q.folio}.pdf`);
      if (fs.existsSync(pdfPath)) {
        fs.unlinkSync(pdfPath);
      }
    });

    console.log(`🗑️ Papelera vaciada: ${deletedQuotations.length} cotizaciones eliminadas`);

    res.json({
      ok: true,
      message: `${deletedQuotations.length} cotizaciones eliminadas permanentemente`,
      count: deletedQuotations.length
    });

  } catch (e) {
    console.error('❌ Error vaciando papelera:', e);
    res.status(500).json({
      ok: false,
      error: 'Error vaciando papelera'
    });
  }
});

// 5. AUTO-LIMPIEZA (ELIMINAR COTIZACIONES > 30 DÍAS)
app.post('/api/trash/auto-clean', async (req, res) => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Obtener cotizaciones eliminadas hace más de 30 días
    const oldQuotations = await prisma.quote.findMany({
      where: {
        deletedAt: { not: null, lt: thirtyDaysAgo }
      },
      select: { id: true, folio: true }
    });

    if (oldQuotations.length === 0) {
      return res.json({
        ok: true,
        message: 'No hay cotizaciones para limpiar',
        count: 0
      });
    }

    // Eliminar items
    const quotationIds = oldQuotations.map(q => q.id);
    await prisma.quoteItem.deleteMany({
      where: { quoteId: { in: quotationIds } }
    });

    // Eliminar cotizaciones
    await prisma.quote.deleteMany({
      where: { id: { in: quotationIds } }
    });

    // Eliminar PDFs
    oldQuotations.forEach(q => {
      const pdfPath = path.join(ORDERS_DIR, `${q.folio}.pdf`);
      if (fs.existsSync(pdfPath)) {
        fs.unlinkSync(pdfPath);
      }
    });

    console.log(`🧹 Auto-limpieza ejecutada: ${oldQuotations.length} cotizaciones eliminadas`);

    res.json({
      ok: true,
      message: `${oldQuotations.length} cotizaciones antiguas eliminadas`,
      count: oldQuotations.length
    });

  } catch (e) {
    console.error('❌ Error en auto-limpieza:', e);
    res.status(500).json({
      ok: false,
      error: 'Error ejecutando auto-limpieza'
    });
  }
});

// ============================================
// FUNCIONES HELPER PARA REGISTRAR ACTIVIDADES
// ============================================

async function logActivity(data) {
  try {
    const activity = await prisma.activity.create({
      data: {
        type: data.type,
        description: data.description,
        metadata: data.metadata || {},
        quoteId: data.quoteId || null,
        saleId: data.saleId || null,
        userId: data.userId || null
      }
    });
    console.log(`📝 Actividad registrada: ${data.type} - ${data.description}`);
    return activity;
  } catch (e) {
    console.error('❌ Error registrando actividad:', e);
    return null;
  }
}

// Helper: Registrar creación de cotización
async function logQuoteCreated(quote) {
  return await logActivity({
    type: 'quote_created',
    description: `Cotización ${quote.folio} creada`,
    quoteId: quote.id,
    userId: quote.createdById,
    metadata: {
      folio: quote.folio,
      total: quote.total,
      client: quote.client?.name || 'Sin cliente'
    }
  });
}

// Helper: Registrar conversión a venta
async function logQuoteConverted(quote, sale) {
  return await logActivity({
    type: 'quote_converted',
    description: `Cotización ${quote.folio} convertida a venta ${sale.folio}`,
    quoteId: quote.id,
    userId: quote.createdById,
    metadata: {
      quoteFolio: quote.folio,
      saleFolio: sale.folio,
      total: sale.total
    }
  });
}

// Helper: Registrar cambio de estado de cotización
async function logQuoteStatusChange(quote, oldStatus, newStatus) {
  return await logActivity({
    type: 'quote_status_changed',
    description: `Estado de ${quote.folio} cambió de "${oldStatus}" a "${newStatus}"`,
    quoteId: quote.id,
    metadata: {
      oldStatus,
      newStatus
    }
  });
}

// Helper: Registrar cambio de estado de venta
async function logSaleStatusChange(sale, field, oldValue, newValue) {
  const fieldNames = {
    status: 'Estado',
    paymentStatus: 'Estado de pago',
    deliveryStatus: 'Estado de entrega'
  };
  
  return await logActivity({
    type: 'sale_status_changed',
    description: `${fieldNames[field]} de ${sale.folio} cambió de "${oldValue}" a "${newValue}"`,
    saleId: sale.id,
    metadata: {
      field,
      oldValue,
      newValue
    }
  });
}

// ============================================
// SALES API (Ventas y Órdenes de Producción)
// ============================================

// Función auxiliar: Crear Orden de Producción
async function createProductionOrder(sale) {
  try {
    const year = new Date().getFullYear();
    const month = String(new Date().getMonth() + 1).padStart(2, '0');
    const ordersCount = await prisma.productionOrder.count();
    const orderNumber = String(ordersCount + 1).padStart(4, '0');
    const orderFolio = `OP-${year}${month}-${orderNumber}`;
    
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 15);
    
    const productionOrder = await prisma.productionOrder.create({
      data: {
        folio: orderFolio,
        saleId: sale.id,
        status: 'pendiente',
        priority: 'normal',
        dueDate: dueDate
      }
    });
    
    const excelPath = await generateProductionOrderExcel(productionOrder, sale);
    
    const updatedOrder = await prisma.productionOrder.update({
      where: { id: productionOrder.id },
      data: { excelPath }
    });
    
    return updatedOrder;
    
  } catch (e) {
    console.error('❌ Error creando orden de producción:', e);
    throw e;
  }
}

// Función auxiliar: Generar Excel de Orden de Producción
async function generateProductionOrderExcel(order, sale) {
  try {
    const fullSale = await prisma.sale.findUnique({
      where: { id: sale.id },
      include: {
        client: true,
        items: {
          include: { product: true }
        },
        quote: true
      }
    });
    
    // 🔍 DEBUG: Verificar valores antes de escribir
    console.log('📊 Valores para Excel:', {
      subtotal: fullSale.subtotal,
      discount: fullSale.discount,
      tax: fullSale.tax,
      total: fullSale.total,
      netMxn: fullSale.netMxn,
      itemsCount: fullSale.items.length
    });
    
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Orden de Producción');
    
    worksheet.columns = [
      { header: 'MODELO', key: 'modelo', width: 20 },
      { header: 'DESCRIPCIÓN', key: 'descripcion', width: 40 },
      { header: 'CANTIDAD', key: 'cantidad', width: 12 },
      { header: 'PRECIO UNIT.', key: 'precio', width: 15 },
      { header: 'SUBTOTAL', key: 'subtotal', width: 15 },
      { header: 'NOTAS', key: 'notas', width: 30 }
    ];
    
    worksheet.mergeCells('A1:F1');
    const titleCell = worksheet.getCell('A1');
    titleCell.value = `ORDEN DE PRODUCCIÓN - ${order.folio}`;
    titleCell.font = { size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF62E41' } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
    worksheet.getRow(1).height = 30;
    
    worksheet.addRow([]);
    worksheet.addRow(['Folio Venta:', fullSale.folio, 'Fecha:', new Date().toLocaleDateString('es-MX')]);
    worksheet.addRow(['Cliente:', fullSale.client?.name || 'N/A', 'Empresa:', fullSale.client?.company || 'N/A']);
    worksheet.addRow(['Teléfono:', fullSale.client?.phone || 'N/A', 'Email:', fullSale.client?.email || 'N/A']);
    worksheet.addRow(['Estado:', fullSale.client?.estado || 'N/A', 'Prioridad:', order.priority.toUpperCase()]);
    worksheet.addRow(['Fecha Entrega:', order.dueDate ? order.dueDate.toLocaleDateString('es-MX') : 'Por definir']);
    worksheet.addRow([]);
    
    for (let i = 3; i <= 8; i++) {
      worksheet.getRow(i).font = { size: 10 };
      worksheet.getCell(`A${i}`).font = { bold: true };
      worksheet.getCell(`C${i}`).font = { bold: true };
    }
    
    worksheet.addRow([]);
    const headerRow = worksheet.addRow(['MODELO', 'DESCRIPCIÓN', 'CANTIDAD', 'PRECIO UNIT.', 'SUBTOTAL', 'NOTAS']);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF333333' } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    headerRow.height = 25;
    
    // Agregar items con conversión explícita a números
    fullSale.items.forEach(item => {
      const row = worksheet.addRow([
        item.modelo,
        item.descripcion || 'Sin descripción',
        parseInt(item.qty) || 0,
        parseFloat(item.unitPrice) || 0,
        parseFloat(item.subtotal) || 0,
        ''
      ]);
      row.alignment = { vertical: 'middle' };
      
      // Formato de moneda para precio y subtotal
      row.getCell(4).numFmt = '"$"#,##0.00';
      row.getCell(5).numFmt = '"$"#,##0.00';
    });
    
    // Fila vacía
    worksheet.addRow([]);
    
    // SUBTOTAL - convertir explícitamente a número
    const subtotalValue = parseFloat(fullSale.subtotal) || 0;
    const subtotalRow = worksheet.addRow(['', '', '', 'SUBTOTAL:', subtotalValue]);
    subtotalRow.getCell(4).font = { bold: true };
    subtotalRow.getCell(5).font = { bold: true };
    subtotalRow.getCell(5).numFmt = '"$"#,##0.00';
    subtotalRow.getCell(5).value = subtotalValue; // Asegurar que sea número
    
    // DESCUENTO
    if (fullSale.discount > 0) {
      const discountValue = parseFloat(fullSale.discount) || 0;
      const discountRow = worksheet.addRow(['', '', '', 'DESCUENTO:', -discountValue]);
      discountRow.getCell(4).font = { bold: true };
      discountRow.getCell(5).font = { bold: true };
      discountRow.getCell(5).numFmt = '"$"#,##0.00';
      discountRow.getCell(5).value = -discountValue;
    }
    
    // IMPUESTO
    if (fullSale.tax > 0) {
      const taxValue = parseFloat(fullSale.tax) || 0;
      const taxRow = worksheet.addRow(['', '', '', 'IMPUESTO:', taxValue]);
      taxRow.getCell(4).font = { bold: true };
      taxRow.getCell(5).font = { bold: true };
      taxRow.getCell(5).numFmt = '"$"#,##0.00';
      taxRow.getCell(5).value = taxValue;
    }
    
    // TOTAL - convertir explícitamente a número
    const totalValue = parseFloat(fullSale.total) || 0;
    const totalRow = worksheet.addRow(['', '', '', 'TOTAL:', totalValue]);
    totalRow.getCell(4).font = { bold: true, size: 12 };
    totalRow.getCell(5).font = { bold: true, size: 12 };
    totalRow.getCell(5).numFmt = `"$"#,##0.00" ${fullSale.currency}"`;
    totalRow.getCell(5).value = totalValue; // Asegurar que sea número
    totalRow.getCell(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
    
    // TOTAL MXN
    if (fullSale.netMxn) {
      const mxnValue = parseFloat(fullSale.netMxn) || 0;
      const mxnRow = worksheet.addRow(['', '', '', 'TOTAL MXN:', mxnValue]);
      mxnRow.getCell(4).font = { bold: true };
      mxnRow.getCell(5).font = { bold: true };
      mxnRow.getCell(5).numFmt = '"$"#,##0.00" MXN"';
      mxnRow.getCell(5).value = mxnValue;
    }
    
    worksheet.addRow([]);
    worksheet.addRow([]);
    worksheet.mergeCells(`A${worksheet.lastRow.number + 1}:F${worksheet.lastRow.number + 1}`);
    const notesCell = worksheet.getCell(`A${worksheet.lastRow.number}`);
    notesCell.value = 'NOTAS DE PRODUCCIÓN:';
    notesCell.font = { bold: true, size: 11 };
    
    worksheet.addRow([]);
    worksheet.mergeCells(`A${worksheet.lastRow.number + 1}:F${worksheet.lastRow.number + 3}`);
    const notesAreaCell = worksheet.getCell(`A${worksheet.lastRow.number}`);
    notesAreaCell.value = order.notes || '(Sin notas adicionales)';
    notesAreaCell.alignment = { vertical: 'top', wrapText: true };
    notesAreaCell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' }
    };
    
    const filename = `${order.folio}_${new Date().getTime()}.xlsx`;
    const filepath = path.join(ORDERS_DIR, filename);
    await workbook.xlsx.writeFile(filepath);
    
    console.log('✅ Excel generado:', filename);
    
    return `/orders/${filename}`;
    
  } catch (e) {
    console.error('❌ Error generando Excel:', e);
    throw e;
  }
}

// GET ALL SALES
app.get('/api/sales', async (req, res) => {
  try {
    const { status, paymentStatus, search } = req.query;
    
    const where = {};
    if (status) where.status = status;
    if (paymentStatus) where.paymentStatus = paymentStatus;
    if (search) {
      where.OR = [
        { folio: { contains: search, mode: 'insensitive' } }
      ];
    }
    
    const sales = await prisma.sale.findMany({
      where,
      include: {
        client: true,
        quote: true,
        items: {
          include: { product: true }
        },
        productionOrders: true
      },
      orderBy: { createdAt: 'desc' },
      take: 100
    });
    
    res.json({ ok: true, sales });
  } catch (e) {
    console.error('Error fetching sales:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET SINGLE SALE
app.get('/api/sales/:id', async (req, res) => {
  try {
    const sale = await prisma.sale.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        client: true,
        quote: {
          include: { client: true, items: true }
        },
        items: {
          include: { product: true }
        },
        productionOrders: true
      }
    });
    
    if (!sale) {
      return res.status(404).json({ ok: false, error: 'Venta no encontrada' });
    }
    
    res.json({ ok: true, sale });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// UPDATE SALE (simplificado para sale_detail.html)
app.put('/api/sales/:id', async (req, res) => {
  try {
    const { status } = req.body;
    
    // Obtener estado anterior
    const oldSale = await prisma.sale.findUnique({
      where: { id: parseInt(req.params.id) }
    });
    
    if (!oldSale) {
      return res.status(404).json({ ok: false, error: 'Venta no encontrada' });
    }
    
    const sale = await prisma.sale.update({
      where: { id: parseInt(req.params.id) },
      data: { status },
      include: {
        client: true,
        items: {
          include: { product: true }
        },
        productionOrders: true
      }
    });
    
    // 📝 Registrar cambio de estado
    if (status && oldSale.status !== status) {
      await logSaleStatusChange(sale, 'status', oldSale.status, status);
    }
    
    res.json({ ok: true, sale });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// UPDATE SALE STATUS (legacy - mantener por compatibilidad)
app.put('/api/sales/:id/status', async (req, res) => {
  try {
    const { status, paymentStatus, deliveryStatus } = req.body;
    
    // Obtener estado anterior
    const oldSale = await prisma.sale.findUnique({
      where: { id: parseInt(req.params.id) }
    });
    
    const updateData = {};
    if (status) updateData.status = status;
    if (paymentStatus) updateData.paymentStatus = paymentStatus;
    if (deliveryStatus) updateData.deliveryStatus = deliveryStatus;
    
    const sale = await prisma.sale.update({
      where: { id: parseInt(req.params.id) },
      data: updateData,
      include: {
        client: true,
        items: true,
        productionOrders: true
      }
    });
    
    // 📝 Registrar cambios de estado
    if (status && oldSale.status !== status) {
      await logSaleStatusChange(sale, 'status', oldSale.status, status);
    }
    if (paymentStatus && oldSale.paymentStatus !== paymentStatus) {
      await logSaleStatusChange(sale, 'paymentStatus', oldSale.paymentStatus, paymentStatus);
    }
    if (deliveryStatus && oldSale.deliveryStatus !== deliveryStatus) {
      await logSaleStatusChange(sale, 'deliveryStatus', oldSale.deliveryStatus, deliveryStatus);
    }
    
    res.json({ ok: true, sale });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET PRODUCTION ORDERS
app.get('/api/production-orders', async (req, res) => {
  try {
    const { status, priority } = req.query;
    
    const where = {};
    if (status) where.status = status;
    if (priority) where.priority = priority;
    
    const orders = await prisma.productionOrder.findMany({
      where,
      include: {
        sale: {
          include: {
            client: true,
            items: true
          }
        }
      },
      orderBy: [
        { priority: 'desc' },
        { dueDate: 'asc' }
      ],
      take: 100
    });
    
    res.json({ ok: true, orders });
  } catch (e) {
    console.error('Error fetching production orders:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// UPDATE PRODUCTION ORDER
app.put('/api/production-orders/:id', async (req, res) => {
  try {
    const { status, priority, dueDate, startDate, notes } = req.body;
    
    const updateData = {};
    if (status) {
      updateData.status = status;
      if (status === 'completada') {
        updateData.completedAt = new Date();
      }
    }
    if (priority) updateData.priority = priority;
    if (dueDate) updateData.dueDate = new Date(dueDate);
    if (startDate) updateData.startDate = new Date(startDate);
    if (notes !== undefined) updateData.notes = notes;
    
    const order = await prisma.productionOrder.update({
      where: { id: parseInt(req.params.id) },
      data: updateData,
      include: {
        sale: {
          include: {
            client: true,
            items: true
          }
        }
      }
    });
    
    res.json({ ok: true, order });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DOWNLOAD PRODUCTION ORDER EXCEL
app.get('/api/production-orders/:id/download', requireAuth, async (req, res) => {
  try {
    const order = await prisma.productionOrder.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        sale: {
          include: {
            client: true,
            quote: { include: { client: true, items: true } }
          }
        }
      }
    });

    if (!order) return res.status(404).json({ error: 'Orden no encontrada' });

    const sale  = order.sale;
    const quote = sale.quote;
    const client = sale.client || quote?.client;

    const mexicoDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });

    const orderData = {
      folio:             quote?.folio || sale.folio || `OP-${order.id}`,
      createdAt:         mexicoDate + 'T12:00:00',
      clientName:        client?.name  || 'Cliente',
      clientCompany:     client?.company || '',
      modelo:            order.productModel || '',
      descripcion:       order.productDescription || '',
      cant:              order.quantity || 1,
      esTransformador:   order.esTransformador || false,
      voltajeMinEntrada: order.voltajeMinEntrada || '',
      voltajeMaxEntrada: order.voltajeMaxEntrada || '',
      voltajeEntrada:    order.voltajeEntrada || '',
      voltajeSalida:     order.voltajeSalida || '',
      adicionales:       order.adicionales || '',
      observaciones:     order.observaciones || '',
    };

    const templatePath  = path.resolve(__dirname, 'FORMATO_ORDEN_DE_PRODUCCION.xlsx');
    const outputDir     = path.resolve(__dirname, 'temp', 'production-orders');
    const outputFilename = `ORDEN_${orderData.folio}_${order.productModel}_${Date.now()}.xlsx`;
    const outputPath    = path.resolve(outputDir, outputFilename);

    if (!fs.existsSync(templatePath)) {
      return res.status(500).json({ error: 'Template no encontrado' });
    }
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const pythonScript = path.resolve(__dirname, 'scripts', 'generate-production-order.py');
    const tempJsonPath = outputPath + '.json';
    fs.writeFileSync(tempJsonPath, JSON.stringify(orderData), 'utf8');

    const { execFile } = require('child_process');
    await new Promise((resolve, reject) => {
      execFile(
        'python3',
        [pythonScript, tempJsonPath, templatePath, outputPath],
        { timeout: 60000 },
        (err, stdout, stderr) => {
          if (stdout) console.log(`🐍 [PYTHON] ${stdout.trim()}`);
          if (stderr) console.log(`🐍 [PYTHON STDERR] ${stderr.trim()}`);
          try { fs.unlinkSync(tempJsonPath); } catch(e) {}
          if (err) reject(new Error(`STDERR: ${stderr} | MSG: ${err.message}`));
          else resolve();
        }
      );
    });

    if (!fs.existsSync(outputPath)) {
      throw new Error('Archivo Excel no se generó correctamente');
    }

    res.download(outputPath, outputFilename, (err) => {
      try { fs.unlinkSync(outputPath); } catch(e) {}
    });

  } catch (e) {
    console.error('❌ [DOWNLOAD OP] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Servir archivos de órdenes
app.use('/orders', express.static(path.join(__dirname, 'orders')));

// ============================================
// EMAIL & WHATSAPP ENDPOINTS
// ============================================

// GET EMAIL DATA (para abrir Gmail/Outlook con datos prellenados)
app.get('/api/quotes/:id/email-data', async (req, res) => {
  try {
    const quoteId = parseInt(req.params.id);
    
    const quote = await prisma.quote.findUnique({
      where: { id: quoteId },
      include: {
        client: true,
        items: true
      }
    });
    
    if (!quote) {
      return res.status(404).json({ ok: false, error: 'Cotización no encontrada' });
    }
    
    // Plantilla de email
    const emailSubject = `Cotización ${quote.folio} - ${quote.client?.company || quote.client?.name || 'Cliente'}`;
    
    const emailBody = `Estimado/a ${quote.client?.name || 'Cliente'},

Adjunto encontrará la cotización ${quote.folio} con los detalles de los productos/servicios solicitados.

Resumen de la cotización:
- Subtotal: $${quote.subtotal?.toFixed(2)} ${quote.currency}
- Total: $${quote.total?.toFixed(2)} ${quote.currency}
${quote.netMxn ? `• Total MXN: $${quote.netMxn?.toFixed(2)} MXN` : ''}

Productos/Servicios incluidos:
${quote.items.map((item, i) => `${i + 1}. ${item.modelo} - ${item.descripcion || 'Sin descripción'} (${item.qty} x $${item.unitPrice?.toFixed(2)})`).join('\n')}

Quedamos atentos a cualquier duda o comentario.

Saludos cordiales,
[Tu Nombre]
[Tu Empresa]`;

    res.json({
      ok: true,
      data: {
        to: quote.client?.email || '',
        subject: emailSubject,
        body: emailBody,
        pdfUrl: `/api/quotes/${quoteId}/pdf-download`
      }
    });
    
  } catch (e) {
    console.error('Error generating email data:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET WHATSAPP DATA (para abrir WhatsApp Web)
app.get('/api/quotes/:id/whatsapp-data', async (req, res) => {
  try {
    const quoteId = parseInt(req.params.id);
    
    const quote = await prisma.quote.findUnique({
      where: { id: quoteId },
      include: {
        client: true,
        items: true
      }
    });
    
    if (!quote) {
      return res.status(404).json({ ok: false, error: 'Cotización no encontrada' });
    }
    
    // Formatear número de teléfono (eliminar caracteres no numéricos)
    let phoneNumber = quote.client?.phone || '';
    phoneNumber = phoneNumber.replace(/\D/g, '');
    
    // Si el número no tiene código de país, asumir México (+52)
    if (phoneNumber.length === 10) {
      phoneNumber = '52' + phoneNumber;
    }
    
    // Mensaje de WhatsApp
    const whatsappMessage = `Hola ${quote.client?.name || 'Cliente'}, 

Te envío la cotización *${quote.folio}* con los detalles solicitados.

📋 *Resumen:*
- Subtotal: $${quote.subtotal?.toFixed(2)} ${quote.currency}
- Total: $${quote.total?.toFixed(2)} ${quote.currency}
${quote.netMxn ? `• Total MXN: $${quote.netMxn?.toFixed(2)} MXN` : ''}

📦 *Productos/Servicios:*
${quote.items.map((item, i) => `${i + 1}. ${item.modelo} - ${item.descripcion || 'Sin descripción'}\n   Cantidad: ${item.qty} | Precio: $${item.unitPrice?.toFixed(2)}`).join('\n\n')}

Adjunto encontrarás el PDF con todos los detalles. ¿Tienes alguna pregunta?`;

    res.json({
      ok: true,
      data: {
        phone: phoneNumber,
        message: whatsappMessage,
        pdfUrl: `/api/quotes/${quoteId}/pdf-download`
      }
    });
    
  } catch (e) {
    console.error('Error generating WhatsApp data:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DOWNLOAD PDF (para adjuntar en email o compartir)
app.get('/api/quotes/:id/pdf-download', requireAuth, async (req, res) => {
  try {
    const quoteId = parseInt(req.params.id);
    
    const quote = await prisma.quote.findUnique({
      where: { id: quoteId },
      include: {
        client: true,
        items: true
      }
    });
    
    if (!quote) {
      return res.status(404).json({ ok: false, error: 'Cotización no encontrada' });
    }
    
    const template = quote.template || 'default-template.pdf';
    
    console.log('🔍 [PDF-DOWNLOAD] Generando descarga para:', quote.folio);
    console.log('  - createdById:', quote.createdById);

    // ⭐ OBTENER FIRMA CON FALLBACK
    let userSignature = null;
    let userId = quote.createdById || req.user?.id;

    if (userId) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { signature: true }
      });
      userSignature = user?.signature || null;
    }
    
    const pdfData = {
      folio: quote.folio,
      userSignature: userSignature,
      fecha: quote.date ? new Date(quote.date).toLocaleDateString('es-MX') : new Date().toLocaleDateString('es-MX'),
      nombre: quote.client?.name || '',
      empresa: quote.client?.company || '',
      correo: quote.client?.email || '',
      numero: quote.client?.phone || '',
      estado: quote.client?.estado || '',
      subtotal: quote.subtotal?.toFixed(2) || '0.00',
      descuento: quote.discount?.toFixed(2) || '0.00',
      impuestos: quote.tax?.toFixed(2) || '0.00',
      total: quote.total?.toFixed(2) || '0.00',
      precio_neto_mxn_formatted: quote.netMxn ? (quote.netMxn.toFixed(2) + ' MXN') : '',
      tiempoEntrega: quote.tiempoEntrega || '',
      formaPago: quote.formaPago || '',
      items: quote.items.map(item => ({
        modelo: item.modelo,
        descripcion: item.descripcion,
        precio: item.unitPrice?.toFixed(2) || '0.00',
        cant: String(item.qty),
        subtotal: item.subtotal?.toFixed(2) || '0.00'
      }))
    };
    
    console.log('  📦 pdfData.userSignature:', pdfData.userSignature || 'UNDEFINED');
    
    // ✅ GENERAR PDF BASE
    const pdfBytes = await generatePdfBuffer(template, pdfData);
    
    // ✅ CARGAR PDF PARA AGREGAR FICHAS
    const pdfDoc = await PDFDocument.load(pdfBytes);
    
    // ⭐ AGREGAR FICHAS TÉCNICAS
    if (quote.items && quote.items.length > 0) {
      const itemsWithFichas = [];
      
      for (const item of quote.items) {
        if (!item.modelo) continue;
        
        try {
          const product = await prisma.product.findFirst({
            where: { 
              model: {
                equals: item.modelo,
                mode: 'insensitive'
              }
            },
            select: { id: true, model: true, ficha: true }
          });
          
          if (product && product.ficha) {
            const fichaPath = path.join(FICHAS_DIR, product.ficha);
            
            if (fs.existsSync(fichaPath)) {
              itemsWithFichas.push({
                modelo: product.model,
                fichaPath: fichaPath,
                fichaFilename: product.ficha
              });
              
              console.log(`  ✅ Ficha encontrada: ${product.model} -> ${product.ficha}`);
            }
          }
        } catch (e) {
          console.warn(`  ⚠️ Error buscando ficha:`, e.message);
        }
      }
      
      if (itemsWithFichas.length > 0) {
        console.log(`  📎 Insertando ${itemsWithFichas.length} fichas...`);
        
        let insertPosition = 1;
        
        for (const item of itemsWithFichas) {
          try {
            const fichaExt = path.extname(item.fichaFilename).toLowerCase();
            
            if (fichaExt === '.pdf') {
              const fichaBytes = fs.readFileSync(item.fichaPath);
              const fichaPdf = await PDFDocument.load(fichaBytes);
              const fichaPages = await pdfDoc.copyPages(fichaPdf, fichaPdf.getPageIndices());
              
              fichaPages.forEach((page, index) => {
                pdfDoc.insertPage(insertPosition + index, page);
              });
              
              insertPosition += fichaPages.length;
              console.log(`    ✅ PDF: ${item.fichaFilename}`);
              
            } else if (['.png', '.jpg', '.jpeg'].includes(fichaExt)) {
              const imageBytes = fs.readFileSync(item.fichaPath);
              let image;
              
              if (fichaExt === '.png') {
                image = await pdfDoc.embedPng(imageBytes);
              } else {
                image = await pdfDoc.embedJpg(imageBytes);
              }
              
              const newPage = pdfDoc.insertPage(insertPosition, [612, 792]);
              const pageWidth = newPage.getWidth();
              const pageHeight = newPage.getHeight();
              
              const imgAspectRatio = image.width / image.height;
              const pageAspectRatio = pageWidth / pageHeight;
              
              let drawWidth, drawHeight, drawX, drawY;
              
              if (imgAspectRatio > pageAspectRatio) {
                drawWidth = pageWidth;
                drawHeight = drawWidth / imgAspectRatio;
                drawX = 0;
                drawY = (pageHeight - drawHeight) / 2;
              } else {
                drawHeight = pageHeight;
                drawWidth = drawHeight * imgAspectRatio;
                drawX = (pageWidth - drawWidth) / 2;
                drawY = 0;
              }
              
              newPage.drawImage(image, {
                x: drawX,
                y: drawY,
                width: drawWidth,
                height: drawHeight
              });
              
              insertPosition++;
              console.log(`    ✅ Imagen: ${item.fichaFilename}`);
            }
            
          } catch (e) {
            console.error(`    ❌ Error:`, e.message);
          }
        }
      }
    }
    
    const finalPdfBytes = await pdfDoc.save();
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=cotizacion_${quote.folio}.pdf`);
    res.send(Buffer.from(finalPdfBytes));
    
    console.log('  ✅ Download generado con fichas');
    
  } catch (e) {
    console.error('❌ Error en pdf-download:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// PREVIEW PDF (para mostrar en iframe sin descargar)
// ============================================
app.get('/api/quotes/:id/pdf-preview', requireAuth, async (req, res) => {
  try {
    const quoteId = parseInt(req.params.id);
    
    const quote = await prisma.quote.findUnique({
      where: { id: quoteId },
      include: {
        client: true,
        items: true
      }
    });
    
    if (!quote) {
      return res.status(404).json({ ok: false, error: 'Cotización no encontrada' });
    }
    
    const template = quote.template || 'default-template.pdf';
    
    console.log('🔍 [PDF-PREVIEW] Generando preview para:', quote.folio);
    console.log('  - createdById:', quote.createdById);
    console.log('  - Usuario actual (req.user):', req.user?.id);
    
    // ⭐⭐⭐ OBTENER FIRMA CON FALLBACK
    let userSignature = null;
    let userId = quote.createdById || req.user?.id;
    
    if (userId) {
      try {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, name: true, signature: true }
        });
        
        if (user) {
          userSignature = user.signature || null;
          console.log('  ✅ Usuario encontrado:', user.name);
          console.log('  🖊️ Firma:', userSignature || 'SIN FIRMA');
          
          if (userSignature) {
            const signaturePath = path.join(__dirname, 'public', 'signatures', userSignature);
            const exists = fs.existsSync(signaturePath);
            console.log('  📁 Archivo existe:', exists ? '✅ SÍ' : '❌ NO', signaturePath);
          }
        } else {
          console.log('  ⚠️ Usuario no encontrado con id:', userId);
        }
      } catch (e) {
        console.error('  ❌ Error cargando usuario:', e.message);
      }
    } else {
      console.log('  ⚠️ Sin createdById ni usuario autenticado');
    }
    
    const pdfData = {
      folio: quote.folio,
      userSignature: userSignature,
      fecha: quote.date ? new Date(quote.date).toLocaleDateString('es-MX') : new Date().toLocaleDateString('es-MX'),
      nombre: quote.client?.name || '',
      empresa: quote.client?.company || '',
      correo: quote.client?.email || '',
      numero: quote.client?.phone || '',
      estado: quote.client?.estado || '',
      subtotal: quote.subtotal?.toFixed(2) || '0.00',
      descuento: quote.discount?.toFixed(2) || '0.00',
      impuestos: quote.tax?.toFixed(2) || '0.00',
      total: quote.total?.toFixed(2) || '0.00',
      precio_neto_mxn_formatted: quote.netMxn ? (quote.netMxn.toFixed(2) + ' MXN') : '',
      tiempoEntrega: quote.tiempoEntrega || '',
      formaPago: quote.formaPago || '',
      items: quote.items.map(item => ({
        modelo: item.modelo,
        descripcion: item.descripcion,
        precio: item.unitPrice?.toFixed(2) || '0.00',
        cant: String(item.qty),
        subtotal: item.subtotal?.toFixed(2) || '0.00'
      }))
    };
    
    console.log('  📦 pdfData.userSignature:', pdfData.userSignature || 'UNDEFINED');
    
    // ✅ GENERAR PDF BASE
    const pdfBytes = await generatePdfBuffer(template, pdfData, { debug: false });
    
    // ============================================
    // ⭐ AGREGAR FICHAS TÉCNICAS EN PÁGINA 2
    // ============================================
    
    const pdfDoc = await PDFDocument.load(pdfBytes);
    
    if (quote.items && quote.items.length > 0) {
      const itemsWithFichas = [];
      
      // Buscar productos con fichas
      for (const item of quote.items) {
        if (!item.modelo) continue;
        
        try {
          const product = await prisma.product.findFirst({
            where: { 
              model: {
                equals: item.modelo,
                mode: 'insensitive'
              }
            },
            select: { id: true, model: true, ficha: true }
          });
          
          if (product && product.ficha) {
            const fichaPath = path.join(FICHAS_DIR, product.ficha);
            
            if (fs.existsSync(fichaPath)) {
              itemsWithFichas.push({
                modelo: product.model,
                fichaPath: fichaPath,
                fichaFilename: product.ficha
              });
              
              console.log(`  ✅ Ficha encontrada: ${product.model} -> ${product.ficha}`);
            }
          }
        } catch (e) {
          console.warn(`  ⚠️ Error buscando ficha para ${item.modelo}:`, e.message);
        }
      }
      
      // Agregar fichas al PDF
      if (itemsWithFichas.length > 0) {
        console.log(`  📎 Insertando ${itemsWithFichas.length} fichas en página 2...`);
        
        let insertPosition = 1; // Posición inicial (página 2 en índice base-0)
        
        for (const item of itemsWithFichas) {
          try {
            const fichaExt = path.extname(item.fichaFilename).toLowerCase();
            
            if (fichaExt === '.pdf') {
              // CASO 1: FICHA PDF
              const fichaBytes = fs.readFileSync(item.fichaPath);
              const fichaPdf = await PDFDocument.load(fichaBytes);
              const fichaPages = await pdfDoc.copyPages(fichaPdf, fichaPdf.getPageIndices());
              
              fichaPages.forEach((page, index) => {
                pdfDoc.insertPage(insertPosition + index, page);
              });
              
              insertPosition += fichaPages.length;
              
              console.log(`    ✅ PDF insertado: ${item.fichaFilename} (${fichaPages.length} páginas)`);
              
            } else if (['.png', '.jpg', '.jpeg'].includes(fichaExt)) {
              // CASO 2: FICHA IMAGEN
              const imageBytes = fs.readFileSync(item.fichaPath);
              let image;
              
              if (fichaExt === '.png') {
                image = await pdfDoc.embedPng(imageBytes);
              } else {
                image = await pdfDoc.embedJpg(imageBytes);
              }
              
              const newPage = pdfDoc.insertPage(insertPosition, [612, 792]);
              const pageWidth = newPage.getWidth();
              const pageHeight = newPage.getHeight();
              
              const imgAspectRatio = image.width / image.height;
              const pageAspectRatio = pageWidth / pageHeight;
              
              let drawWidth, drawHeight, drawX, drawY;
              
              if (imgAspectRatio > pageAspectRatio) {
                drawWidth = pageWidth;
                drawHeight = drawWidth / imgAspectRatio;
                drawX = 0;
                drawY = (pageHeight - drawHeight) / 2;
              } else {
                drawHeight = pageHeight;
                drawWidth = drawHeight * imgAspectRatio;
                drawX = (pageWidth - drawWidth) / 2;
                drawY = 0;
              }
              
              newPage.drawImage(image, {
                x: drawX,
                y: drawY,
                width: drawWidth,
                height: drawHeight
              });
              
              insertPosition++;
              
              console.log(`    ✅ Imagen insertada: ${item.fichaFilename}`);
            }
            
          } catch (e) {
            console.error(`    ❌ Error procesando ficha ${item.fichaFilename}:`, e.message);
          }
        }
      }
    }
    
    // ============================================
    // GUARDAR Y ENVIAR PDF FINAL
    // ============================================
    
    const finalPdfBytes = await pdfDoc.save();
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=preview_${quote.folio}.pdf`);
    res.setHeader('Cache-Control', 'no-cache');
    res.send(Buffer.from(finalPdfBytes));
    
    console.log('  ✅ Preview generado con fichas');
    
  } catch (e) {
    console.error('❌ Error en pdf-preview:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});
// REGISTRAR ENVÍO EN HISTORIAL
app.post('/api/quotes/:id/log-send', async (req, res) => {
  try {
    const quoteId = parseInt(req.params.id);
    const { method, recipient } = req.body; // method: 'email' | 'whatsapp'
    
    const quote = await prisma.quote.findUnique({
      where: { id: quoteId }
    });
    
    if (!quote) {
      return res.status(404).json({ ok: false, error: 'Cotización no encontrada' });
    }
    
    const description = method === 'email' 
      ? `Cotización enviada por email a ${recipient}`
      : `Cotización enviada por WhatsApp a ${recipient}`;
    
    const activity = await logActivity({
      type: 'quote_sent',
      description,
      quoteId,
      metadata: {
        method,
        recipient,
        folio: quote.folio
      }
    });
    
    res.json({ ok: true, activity });
    
  } catch (e) {
    console.error('Error logging send:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// SEND EMAIL DIRECTLY (Nodemailer) - VERSIÓN CON CC/BCC Y FICHAS
// ============================================
app.post('/api/quotes/:id/send-email', requireAuth, async (req, res) => {
  try {
  // ⭐ Obtener credenciales del usuario logueado
    const userIdEmail = req.user?.id;
    const usuario = await prisma.user.findUnique({ where: { id: userIdEmail } });

    // Usar credenciales del usuario si las tiene, si no caer al transporter global
    let transporterActivo = transporter;
    let fromActivo = `"${process.env.EMAIL_FROM_NAME}" <${process.env.EMAIL_FROM_ADDRESS}>`;

    if (usuario?.emailPassword && usuario?.email) {
      transporterActivo = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        auth: {
          user: usuario.email,
          pass: usuario.emailPassword
        }
      });
      fromActivo = `"${usuario.emailFrom || usuario.name}" <${usuario.email}>`;
    }

    if (!transporterActivo) {
      return res.status(500).json({ 
        ok: false, 
        error: 'No hay configuración de correo. Configura tu correo en tu perfil.' 
      });
    }

    const quoteId = parseInt(req.params.id);
    
    // ⭐ EXTRAER CC/BCC/CUSTOM MESSAGE DEL BODY
    const { customMessage, cc, bcc } = req.body;
    
    console.log('🔍 [SEND-EMAIL] Enviando cotización:', quoteId);
    console.log('  - CC:', cc || 'ninguno');
    console.log('  - BCC:', bcc || 'ninguno');
    
    const quote = await prisma.quote.findUnique({
      where: { id: quoteId },
      include: {
        client: true,
        items: true
      }
    });
    
    if (!quote) {
      return res.status(404).json({ ok: false, error: 'Cotización no encontrada' });
    }

    if (!quote.client?.email) {
      return res.status(400).json({ ok: false, error: 'El cliente no tiene email registrado' });
    }

    // ✅ USAR EL TEMPLATE DE LA COTIZACIÓN
    const template = quote.template || 'default-template.pdf';
    
    console.log('  - Template:', template);
    console.log('  - Cliente email:', quote.client.email);

    // ✅ VERIFICAR QUE EXISTE EL TEMPLATE
    const templatePath = path.join(TEMPLATES_DIR, template);
    if (!fs.existsSync(templatePath)) {
      console.error('❌ Template no encontrado:', templatePath);
      return res.status(404).json({ 
        ok: false, 
        error: `Template "${template}" no encontrado en el servidor` 
      });
    }
    console.log('  ✅ Template existe:', templatePath);

    // ⭐ OBTENER FIRMA CON FALLBACK
    let userSignature = null;
    let userId = quote.createdById || req.user?.id;

    if (userId) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { signature: true }
      });
      userSignature = user?.signature || null;
    }

    // Preparar datos para el PDF
    const pdfData = {
      folio: quote.folio,
      userSignature: userSignature,
      fecha: quote.date ? new Date(quote.date).toLocaleDateString('es-MX') : new Date().toLocaleDateString('es-MX'),
      nombre: quote.client?.name || '',
      empresa: quote.client?.company || '',
      correo: quote.client?.email || '',
      numero: quote.client?.phone || '',
      estado: quote.client?.estado || '',
      subtotal: quote.subtotal?.toFixed(2) || '0.00',
      descuento: quote.discount?.toFixed(2) || '0.00',
      impuestos: quote.tax?.toFixed(2) || '0.00',
      total: quote.total?.toFixed(2) || '0.00',
      precio_neto_mxn_formatted: quote.netMxn ? (quote.netMxn.toFixed(2) + ' MXN') : '',
      tiempoEntrega: quote.tiempoEntrega || '',
      formaPago: quote.formaPago || '',
      items: quote.items.map(item => ({
        modelo: item.modelo,
        descripcion: item.descripcion,
        precio: item.unitPrice?.toFixed(2) || '0.00',
        cant: String(item.qty),
        subtotal: item.subtotal?.toFixed(2) || '0.00'
      }))
    };

    console.log('  📦 Datos preparados. Items:', pdfData.items.length);

    // ✅ GENERAR PDF BASE
    console.log('  🔄 Generando PDF base...');
    const pdfBytes = await generatePdfBuffer(template, pdfData);
    console.log('  ✅ PDF base generado:', pdfBytes.length, 'bytes');

    // ============================================
    // ⭐ AGREGAR FICHAS TÉCNICAS
    // ============================================
    
    const pdfDoc = await PDFDocument.load(pdfBytes);
    
    if (quote.items && quote.items.length > 0) {
      const itemsWithFichas = [];
      
      // Buscar productos con fichas
      console.log('  🔍 Buscando fichas técnicas...');
      
      for (const item of quote.items) {
        if (!item.modelo) continue;
        
        try {
          const product = await prisma.product.findFirst({
            where: { 
              model: {
                equals: item.modelo,
                mode: 'insensitive'
              }
            },
            select: { id: true, model: true, ficha: true }
          });
          
          if (product && product.ficha) {
            const fichaPath = path.join(FICHAS_DIR, product.ficha);
            
            if (fs.existsSync(fichaPath)) {
              itemsWithFichas.push({
                modelo: product.model,
                fichaPath: fichaPath,
                fichaFilename: product.ficha
              });
              
              console.log(`    ✅ Ficha encontrada: ${product.model} -> ${product.ficha}`);
            }
          }
        } catch (e) {
          console.warn(`    ⚠️ Error buscando ficha para ${item.modelo}:`, e.message);
        }
      }
      
      // Agregar fichas al PDF
      if (itemsWithFichas.length > 0) {
        console.log(`  📎 Insertando ${itemsWithFichas.length} fichas técnicas...`);
        
        let insertPosition = 1; // Página 2
        
        for (const item of itemsWithFichas) {
          try {
            const fichaExt = path.extname(item.fichaFilename).toLowerCase();
            
            if (fichaExt === '.pdf') {
              // CASO 1: FICHA PDF
              const fichaBytes = fs.readFileSync(item.fichaPath);
              const fichaPdf = await PDFDocument.load(fichaBytes);
              const fichaPages = await pdfDoc.copyPages(fichaPdf, fichaPdf.getPageIndices());
              
              fichaPages.forEach((page, index) => {
                pdfDoc.insertPage(insertPosition + index, page);
              });
              
              insertPosition += fichaPages.length;
              
              console.log(`    ✅ PDF insertado: ${item.fichaFilename} (${fichaPages.length} páginas)`);
              
            } else if (['.png', '.jpg', '.jpeg'].includes(fichaExt)) {
              // CASO 2: FICHA IMAGEN
              const imageBytes = fs.readFileSync(item.fichaPath);
              let image;
              
              if (fichaExt === '.png') {
                image = await pdfDoc.embedPng(imageBytes);
              } else {
                image = await pdfDoc.embedJpg(imageBytes);
              }
              
              const newPage = pdfDoc.insertPage(insertPosition, [612, 792]);
              const pageWidth = newPage.getWidth();
              const pageHeight = newPage.getHeight();
              
              const imgAspectRatio = image.width / image.height;
              const pageAspectRatio = pageWidth / pageHeight;
              
              let drawWidth, drawHeight, drawX, drawY;
              
              if (imgAspectRatio > pageAspectRatio) {
                drawWidth = pageWidth;
                drawHeight = drawWidth / imgAspectRatio;
                drawX = 0;
                drawY = (pageHeight - drawHeight) / 2;
              } else {
                drawHeight = pageHeight;
                drawWidth = drawHeight * imgAspectRatio;
                drawX = (pageWidth - drawWidth) / 2;
                drawY = 0;
              }
              
              newPage.drawImage(image, {
                x: drawX,
                y: drawY,
                width: drawWidth,
                height: drawHeight
              });
              
              insertPosition++;
              
              console.log(`    ✅ Imagen insertada: ${item.fichaFilename}`);
            }
            
          } catch (e) {
            console.error(`    ❌ Error procesando ficha ${item.fichaFilename}:`, e.message);
          }
        }
      } else {
        console.log('  ℹ️ No se encontraron fichas técnicas para esta cotización');
      }
    }
    
    // ============================================
    // GUARDAR PDF FINAL CON FICHAS
    // ============================================
    
    console.log('  💾 Guardando PDF final...');
    const finalPdfBuffer = await pdfDoc.save();
    console.log('  ✅ PDF final generado:', finalPdfBuffer.length, 'bytes');

    // ============================================
    // TU emailHTML EXISTENTE (NO LO MODIFICO)
    // ============================================
    const emailHTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; background: #f4f4f4; margin: 0; padding: 0; }
    .container { max-width: 600px; margin: 20px auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .header { background: linear-gradient(135deg, #F62E41, #D22634); color: white; padding: 30px; text-align: center; }
    .header h1 { margin: 0; font-size: 24px; }
    .header p { margin: 10px 0 0 0; opacity: 0.9; }
    .content { padding: 30px; }
    .greeting { font-size: 16px; margin-bottom: 20px; }
    .message { margin-bottom: 20px; line-height: 1.8; }
    .quote-info { background: #f8f9fa; border-left: 4px solid #F62E41; padding: 15px; margin: 20px 0; border-radius: 4px; }
    .quote-info h3 { margin: 0 0 10px 0; color: #F62E41; }
    .info-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #e9ecef; }
    .info-row:last-child { border-bottom: none; }
    .info-label { font-weight: 600; color: #6c757d; }
    .info-value { font-weight: 700; color: #333; }
    .items-table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    .items-table th { background: #f8f9fa; padding: 12px; text-align: left; font-size: 12px; font-weight: 600; color: #6c757d; text-transform: uppercase; border-bottom: 2px solid #dee2e6; }
    .items-table td { padding: 12px; border-bottom: 1px solid #e9ecef; }
    .items-table tr:last-child td { border-bottom: none; }
    .cta { text-align: center; margin: 30px 0; }
    .cta-button { display: inline-block; padding: 15px 30px; background: linear-gradient(135deg, #F62E41, #D22634); color: white; text-decoration: none; border-radius: 6px; font-weight: 600; box-shadow: 0 4px 12px rgba(246,46,65,0.3); }
    .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 13px; color: #6c757d; border-top: 1px solid #e9ecef; }
    .footer p { margin: 5px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📋 Cotización ${quote.folio}</h1>
      <p>${process.env.EMAIL_FROM_NAME || 'Tu Empresa'}</p>
    </div>
    
    <div class="content">
      <div class="greeting">
        Estimado/a <strong>${quote.client.name}</strong>,
      </div>
      
      <div class="message">
        Adjunto encontrará la cotización <strong>${quote.folio}</strong> con los detalles de los productos/servicios solicitados.
        <br><br>
        Quedamos atentos a cualquier duda o comentario que pueda tener.
      </div>
      
      <div class="quote-info">
        <h3>📊 Resumen de la Cotización</h3>
        <div class="info-row">
          <span class="info-label">Folio:</span>
          <span class="info-value">${quote.folio}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Fecha:</span>
          <span class="info-value">${new Date(quote.date).toLocaleDateString('es-MX')}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Subtotal:</span>
          <span class="info-value">$${quote.subtotal?.toFixed(2)} ${quote.currency}</span>
        </div>
        ${quote.discount > 0 ? `
        <div class="info-row">
          <span class="info-label">Descuento:</span>
          <span class="info-value">-$${quote.discount?.toFixed(2)} ${quote.currency}</span>
        </div>
        ` : ''}
        ${quote.tax > 0 ? `
        <div class="info-row">
          <span class="info-label">Impuestos:</span>
          <span class="info-value">$${quote.tax?.toFixed(2)} ${quote.currency}</span>
        </div>
        ` : ''}
        <div class="info-row">
          <span class="info-label">TOTAL:</span>
          <span class="info-value" style="font-size: 18px; color: #F62E41;">$${quote.total?.toFixed(2)} ${quote.currency}</span>
        </div>
        ${quote.netMxn ? `
        <div class="info-row">
          <span class="info-label">Total MXN:</span>
          <span class="info-value">$${quote.netMxn?.toFixed(2)} MXN</span>
        </div>
        ` : ''}
        ${quote.tiempoEntrega ? `
        <div class="info-row">
          <span class="info-label">⏰ Tiempo de Entrega:</span>
          <span class="info-value">${quote.tiempoEntrega}</span>
        </div>
        ` : ''}
        ${quote.formaPago ? `
        <div class="info-row">
          <span class="info-label">💳 Forma de Pago:</span>
          <span class="info-value">${quote.formaPago}</span>
        </div>
        ` : ''}
      </div>
      
      <h3 style="margin-top: 30px; color: #333;">📦 Productos/Servicios</h3>
      <table class="items-table">
        <thead>
          <tr>
            <th>Modelo</th>
            <th>Descripción</th>
            <th style="text-align: right;">Cant.</th>
            <th style="text-align: right;">P. Unit.</th>
            <th style="text-align: right;">Subtotal</th>
          </tr>
        </thead>
        <tbody>
          ${quote.items.map(item => `
            <tr>
              <td><strong>${item.modelo}</strong></td>
              <td>${item.descripcion || 'Sin descripción'}</td>
              <td style="text-align: right;">${item.qty}</td>
              <td style="text-align: right;">$${item.unitPrice?.toFixed(2)}</td>
              <td style="text-align: right;"><strong>$${item.subtotal?.toFixed(2)}</strong></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      
      <div class="cta">
        <p style="margin-bottom: 15px;">El PDF con todos los detalles está adjunto a este correo.</p>
      </div>
    </div>
    
    <div class="footer">
      <p><strong>${process.env.EMAIL_FROM_NAME || 'Tu Empresa'}</strong></p>
      <p>${process.env.EMAIL_FROM_ADDRESS || ''}</p>
      <p>Este es un correo automático del Sistema de Gestión de Cotizaciones</p>
    </div>
  </div>
</body>
</html>
    `;

    // ⭐ CONFIGURAR EMAIL CON CC/BCC
    const mailOptions = {
      from: fromActivo,
      to: quote.client.email,
      subject: `Cotización ${quote.folio} - ${quote.client.company || quote.client.name}`,
      html: emailHTML,
      attachments: [
        {
          filename: `cotizacion_${quote.folio}.pdf`,
          content: finalPdfBuffer // ⭐ USAR PDF CON FICHAS
        }
      ]
    };

    // ⭐ AGREGAR CC SI EXISTE
    if (cc && cc.trim()) {
      mailOptions.cc = cc.trim();
      console.log('  ✅ CC agregado:', cc);
    }

    // ⭐ AGREGAR BCC SI EXISTE
    if (bcc && bcc.trim()) {
      mailOptions.bcc = bcc.trim();
      console.log('  ✅ BCC agregado:', bcc);
    }

    console.log('  📧 Enviando email a:', {
      to: mailOptions.to,
      cc: mailOptions.cc || 'ninguno',
      bcc: mailOptions.bcc || 'ninguno',
      attachmentSize: `${(finalPdfBuffer.length / 1024).toFixed(2)} KB`
    });

    // Enviar email
    const info = await transporterActivo.sendMail(mailOptions);
    
    console.log('  ✅ Email enviado exitosamente:', info.messageId);

    // Construir descripción de actividad
    let activityDescription = `Cotización enviada por email (directo) a ${quote.client.email}`;
    if (cc) activityDescription += ` (CC: ${cc})`;
    if (bcc) activityDescription += ` (CCO: ${bcc})`;

    // Registrar envío en historial
    await logActivity({
      type: 'quote_sent',
      description: activityDescription,
      quoteId,
      metadata: {
        method: 'email_direct',
        recipient: quote.client.email,
        cc: cc || null,
        bcc: bcc || null,
        folio: quote.folio,
        messageId: info.messageId,
        status: 'sent',
        template: template,
        withFichas: true
      }
    });

    res.json({ 
      ok: true, 
      message: 'Email enviado correctamente',
      messageId: info.messageId,
      recipient: quote.client.email,
      cc: cc || null,
      bcc: bcc || null,
      template: template
    });
    
  } catch (e) {
    console.error('❌ Error enviando email:', e);
    console.error('Stack:', e.stack);
    
    // Registrar error en historial
    try {
      await logActivity({
        type: 'quote_sent',
        description: `Error enviando cotización por email: ${e.message}`,
        quoteId: parseInt(req.params.id),
        metadata: {
          method: 'email_direct',
          status: 'error',
          error: e.message
        }
      });
    } catch (logError) {
      console.error('Error logging activity:', logError);
    }
    
    res.status(500).json({ 
      ok: false, 
      error: 'Error enviando email: ' + e.message 
    });
  }
});

// TEST EMAIL CONFIGURATION
app.get('/api/email/test', async (req, res) => {
  try {
    if (!transporter) {
      return res.status(500).json({ 
        ok: false, 
        error: 'Email no configurado. Revisa EMAIL_USER y EMAIL_PASSWORD en .env' 
      });
    }

    // Verificar configuración
    await transporter.verify();
    
    res.json({ 
      ok: true, 
      message: 'Configuración de email correcta',
      config: {
        host: emailConfig.host,
        port: emailConfig.port,
        user: emailConfig.auth.user,
        from: process.env.EMAIL_FROM_ADDRESS
      }
    });
  } catch (e) {
    res.status(500).json({ 
      ok: false, 
      error: 'Error en configuración de email: ' + e.message,
      details: e.toString()
    });
  }
});

// ============================================
// ACTIVITIES API (Historial y Seguimiento)
// ============================================

// GET ACTIVITIES FOR QUOTE
app.get('/api/quotes/:id/activities', async (req, res) => {
  try {
    const quoteId = parseInt(req.params.id);
    
    const activities = await prisma.activity.findMany({
      where: { quoteId },
      include: {
        user: {
          select: { id: true, name: true, email: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    
    res.json({ ok: true, activities });
  } catch (e) {
    console.error('Error fetching quote activities:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ADD NOTE TO QUOTE
app.post('/api/quotes/:id/notes', async (req, res) => {
  try {
    const quoteId = parseInt(req.params.id);
    const { note, userId } = req.body;
    
    if (!note || note.trim() === '') {
      return res.status(400).json({ ok: false, error: 'La nota no puede estar vacía' });
    }
    
    // Verificar que la cotización existe
    const quote = await prisma.quote.findUnique({
      where: { id: quoteId }
    });
    
    if (!quote) {
      return res.status(404).json({ ok: false, error: 'Cotización no encontrada' });
    }
    
    // Crear actividad
    const activity = await logActivity({
      type: 'note_added',
      description: note,
      quoteId,
      userId,
      metadata: {
        folio: quote.folio
      }
    });
    
    res.json({ ok: true, activity });
  } catch (e) {
    console.error('Error adding note to quote:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET ACTIVITIES FOR SALE
app.get('/api/sales/:id/activities', async (req, res) => {
  try {
    const saleId = parseInt(req.params.id);
    
    const activities = await prisma.activity.findMany({
      where: { saleId },
      include: {
        user: {
          select: { id: true, name: true, email: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    
    res.json({ ok: true, activities });
  } catch (e) {
    console.error('Error fetching sale activities:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ADD NOTE/ACTIVITY TO SALE (actualizado para recibir "type" y "description")
app.post('/api/sales/:id/activities', async (req, res) => {
  try {
    const saleId = parseInt(req.params.id);
    const { type, description, userId } = req.body;
    
    if (!description || description.trim() === '') {
      return res.status(400).json({ ok: false, error: 'La descripción no puede estar vacía' });
    }
    
    // Verificar que la venta existe
    const sale = await prisma.sale.findUnique({
      where: { id: saleId }
    });
    
    if (!sale) {
      return res.status(404).json({ ok: false, error: 'Venta no encontrada' });
    }
    
    // Crear actividad
    const activity = await logActivity({
      type: type || 'note_added',
      description,
      saleId,
      userId,
      metadata: {
        folio: sale.folio
      }
    });
    
    res.json({ ok: true, activity });
  } catch (e) {
    console.error('Error adding activity to sale:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET ALL ACTIVITIES (TIMELINE GLOBAL)
app.get('/api/activities', async (req, res) => {
  try {
    const { type, limit = 50 } = req.query;
    
    const where = {};
    if (type) where.type = type;
    
    const activities = await prisma.activity.findMany({
      where,
      include: {
        user: {
          select: { id: true, name: true, email: true }
        },
        quote: {
          select: { id: true, folio: true }
        },
        sale: {
          select: { id: true, folio: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit)
    });
    
    res.json({ ok: true, activities });
  } catch (e) {
    console.error('Error fetching activities:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// AUTHENTICATION API
// ============================================

/**
 * POST /api/auth/login
 * Iniciar sesión
 */
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Validación
    if (!email || !password) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Email y password son requeridos' 
      });
    }
    
    if (!isValidEmail(email)) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Email inválido' 
      });
    }
    
    console.log('🔐 Intento de login:', email);
    
    // Buscar usuario
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() }
    });
    
    if (!user) {
      console.warn('⚠️ Usuario no encontrado:', email);
      return res.status(401).json({ 
        ok: false, 
        error: 'Email o password incorrectos' 
      });
    }
    
    // Verificar si está activo
    if (!user.active) {
      console.warn('⚠️ Usuario desactivado:', email);
      return res.status(401).json({ 
        ok: false, 
        error: 'Usuario desactivado. Contacta al administrador.' 
      });
    }
    
    // Verificar password
    const isPasswordValid = await verifyPassword(password, user.password);
    
    if (!isPasswordValid) {
      console.warn('⚠️ Password incorrecto para:', email);
      return res.status(401).json({ 
        ok: false, 
        error: 'Email o password incorrectos' 
      });
    }
    
    // Generar token
    const token = generateToken({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role
    });
    
    // Establecer cookie
    res.cookie(AUTH_CONFIG.COOKIE_NAME, token, AUTH_CONFIG.COOKIE_OPTIONS);
    
    console.log('✅ Login exitoso:', user.email, `(${user.role})`);
    
    // Registrar actividad
    await logActivity({
      type: 'user_login',
      description: `Usuario ${user.name} inició sesión`,
      userId: user.id,
      metadata: {
        email: user.email,
        role: user.role
      }
    });
    
    res.json({ 
      ok: true, 
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      },
      message: 'Login exitoso'
    });
    
  } catch (e) {
    console.error('❌ Error en login:', e);
    res.status(500).json({ ok: false, error: 'Error en el servidor' });
  }
});

/**
 * POST /api/auth/logout
 * Cerrar sesión
 */
app.post('/api/auth/logout', requireAuth, async (req, res) => {
  try {
    console.log('🚪 Logout:', req.user.email);
    
    // Registrar actividad
    await logActivity({
      type: 'user_logout',
      description: `Usuario ${req.user.name} cerró sesión`,
      userId: req.user.id,
      metadata: {
        email: req.user.email
      }
    });
    
    // Limpiar cookie
    res.clearCookie(AUTH_CONFIG.COOKIE_NAME);
    
    res.json({ ok: true, message: 'Logout exitoso' });
    
  } catch (e) {
    console.error('❌ Error en logout:', e);
    res.status(500).json({ ok: false, error: 'Error en el servidor' });
  }
});

/**
 * GET /api/auth/me
 * Obtener información del usuario actual
 */
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        active: true,
        createdAt: true,
        emailFrom: true,
        emailPassword: true
      }
    });
    
    if (!user) {
      return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    }
    
    res.json({ ok: true, user });
    
  } catch (e) {
    console.error('❌ Error en /auth/me:', e);
    res.status(500).json({ ok: false, error: 'Error en el servidor' });
  }
});

/**
 * POST /api/auth/check
 * Verificar si el usuario está autenticado (sin requireAuth)
 */
app.post('/api/auth/check', async (req, res) => {
  try {
    const token = req.cookies[AUTH_CONFIG.COOKIE_NAME];
    
    if (!token) {
      return res.json({ ok: true, authenticated: false });
    }
    
    const { verifyToken } = require('./auth');
    const decoded = verifyToken(token);
    
    if (!decoded) {
      return res.json({ ok: true, authenticated: false });
    }
    
    // Verificar que el usuario existe y está activo
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, active: true, name: true, email: true, role: true }
    });
    
    if (!user || !user.active) {
      res.clearCookie(AUTH_CONFIG.COOKIE_NAME);
      return res.json({ ok: true, authenticated: false });
    }
    
    res.json({ 
      ok: true, 
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role
      }
    });
    
  } catch (e) {
    console.error('❌ Error en /auth/check:', e);
    res.json({ ok: true, authenticated: false });
  }
});

/**
 * POST /api/auth/change-password
 * Cambiar password propio (requiere password actual)
 */
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    // Validaciones
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Password actual y nuevo password son requeridos' 
      });
    }
    
    const passwordValidation = validatePassword(newPassword);
    if (!passwordValidation.valid) {
      return res.status(400).json({ 
        ok: false, 
        error: passwordValidation.error 
      });
    }
    
    // Obtener usuario
    const user = await prisma.user.findUnique({
      where: { id: req.user.id }
    });
    
    if (!user) {
      return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    }
    
    // Verificar password actual
    const isPasswordValid = await verifyPassword(currentPassword, user.password);
    
    if (!isPasswordValid) {
      return res.status(401).json({ 
        ok: false, 
        error: 'Password actual incorrecto' 
      });
    }
    
    // Hashear nuevo password
    const hashedPassword = await hashPassword(newPassword);
    
    // Actualizar password
    await prisma.user.update({
      where: { id: req.user.id },
      data: { password: hashedPassword }
    });
    
    console.log('✅ Password cambiado:', user.email);
    
    // Registrar actividad
    await logActivity({
      type: 'password_changed',
      description: `${user.name} cambió su password`,
      userId: user.id,
      metadata: {
        email: user.email
      }
    });
    
    res.json({ ok: true, message: 'Password actualizado correctamente' });
    
  } catch (e) {
    console.error('❌ Error cambiando password:', e);
    res.status(500).json({ ok: false, error: 'Error en el servidor' });
  }
});

// ============================================
// USERS MANAGEMENT API (Admin only)
// ============================================

/**
 * GET /api/users
 * Listar todos los usuarios (solo admin)
 */
app.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        active: true,
        createdAt: true,
        _count: {
          select: {
            quotes: true,
            sales: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    
    res.json({ ok: true, users });
    
  } catch (e) {
    console.error('❌ Error listando usuarios:', e);
    res.status(500).json({ ok: false, error: 'Error en el servidor' });
  }
});

/**
 * POST /api/users
 * Crear nuevo usuario (solo admin)
 */
app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    
    // Validaciones
    if (!name || !email || !password) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Nombre, email y password son requeridos' 
      });
    }
    
    if (!isValidEmail(email)) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Email inválido' 
      });
    }
    
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({ 
        ok: false, 
        error: passwordValidation.error 
      });
    }
    
    if (role && !isValidRole(role)) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Rol inválido. Debe ser: admin o vendedor' 
      });
    }
    
    // Verificar si el email ya existe
    const existingUser = await prisma.user.findUnique({
      where: { email: email.toLowerCase() }
    });
    
    if (existingUser) {
      return res.status(400).json({ 
        ok: false, 
        error: 'El email ya está registrado' 
      });
    }
    
    // Hashear password
    const hashedPassword = await hashPassword(password);
    
    // Crear usuario
    const user = await prisma.user.create({
      data: {
        name,
        email: email.toLowerCase(),
        password: hashedPassword,
        role: role || 'vendedor',
        active: true
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        active: true,
        createdAt: true
      }
    });
    
    console.log('✅ Usuario creado:', user.email, `(${user.role})`);
    
    // Registrar actividad
    await logActivity({
      type: 'user_created',
      description: `Usuario ${user.name} fue creado por ${req.user.name}`,
      userId: req.user.id,
      metadata: {
        newUserId: user.id,
        newUserEmail: user.email,
        newUserRole: user.role,
        createdBy: req.user.email
      }
    });
    
    res.json({ ok: true, user });
    
  } catch (e) {
    console.error('❌ Error creando usuario:', e);
    res.status(500).json({ ok: false, error: 'Error en el servidor' });
  }
});

/**
 * PUT /api/users/:id
 * Actualizar usuario (solo admin)
 */
app.put('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { name, email, password, role, active } = req.body;
    
    // Verificar que el usuario existe
    const existingUser = await prisma.user.findUnique({
      where: { id: userId }
    });
    
    if (!existingUser) {
      return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    }
    
    // Prevenir que el admin se desactive a sí mismo
    if (userId === req.user.id && active === false) {
      return res.status(400).json({ 
        ok: false, 
        error: 'No puedes desactivarte a ti mismo' 
      });
    }
    
    // Preparar datos de actualización
    const updateData = {};
    
    if (name) updateData.name = name;
    
    if (email) {
      if (!isValidEmail(email)) {
        return res.status(400).json({ ok: false, error: 'Email inválido' });
      }
      
      // Verificar que el email no esté en uso por otro usuario
      if (email.toLowerCase() !== existingUser.email.toLowerCase()) {
        const emailInUse = await prisma.user.findUnique({
          where: { email: email.toLowerCase() }
        });
        
        if (emailInUse) {
          return res.status(400).json({ 
            ok: false, 
            error: 'El email ya está en uso' 
          });
        }
      }
      
      updateData.email = email.toLowerCase();
    }
    
    if (password) {
      const passwordValidation = validatePassword(password);
      if (!passwordValidation.valid) {
        return res.status(400).json({ 
          ok: false, 
          error: passwordValidation.error 
        });
      }
      
      updateData.password = await hashPassword(password);
    }
    
    if (role && isValidRole(role)) {
      updateData.role = role;
    }
    
    if (typeof active === 'boolean') {
      updateData.active = active;
    }
    
    // Actualizar usuario
    const user = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        active: true,
        createdAt: true
      }
    });
    
    console.log('✅ Usuario actualizado:', user.email);
    
    // Registrar actividad
    await logActivity({
      type: 'user_updated',
      description: `Usuario ${user.name} fue actualizado por ${req.user.name}`,
      userId: req.user.id,
      metadata: {
        updatedUserId: user.id,
        updatedUserEmail: user.email,
        changes: Object.keys(updateData),
        updatedBy: req.user.email
      }
    });
    
    res.json({ ok: true, user });
    
  } catch (e) {
    console.error('❌ Error actualizando usuario:', e);
    res.status(500).json({ ok: false, error: 'Error en el servidor' });
  }
});

/**
 * DELETE /api/users/:id
 * Eliminar usuario (solo admin)
 */
app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    
    // Prevenir que el admin se elimine a sí mismo
    if (userId === req.user.id) {
      return res.status(400).json({ 
        ok: false, 
        error: 'No puedes eliminarte a ti mismo' 
      });
    }
    
    // Verificar que el usuario existe
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true }
    });
    
    if (!user) {
      return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    }
    
    // Eliminar usuario
    await prisma.user.delete({
      where: { id: userId }
    });
    
    console.log('✅ Usuario eliminado:', user.email);
    
    // Registrar actividad
    await logActivity({
      type: 'user_deleted',
      description: `Usuario ${user.name} fue eliminado por ${req.user.name}`,
      userId: req.user.id,
      metadata: {
        deletedUserId: user.id,
        deletedUserEmail: user.email,
        deletedBy: req.user.email
      }
    });
    
    res.json({ ok: true, message: 'Usuario eliminado correctamente' });
    
  } catch (e) {
    console.error('❌ Error eliminando usuario:', e);
    res.status(500).json({ ok: false, error: 'Error en el servidor' });
  }
});

/**
 * POST /api/users/:id/toggle-active
 * Activar/Desactivar usuario (solo admin)
 */
app.post('/api/users/:id/toggle-active', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    
    // Prevenir que el admin se desactive a sí mismo
    if (userId === req.user.id) {
      return res.status(400).json({ 
        ok: false, 
        error: 'No puedes desactivarte a ti mismo' 
      });
    }
    
    // Obtener usuario actual
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });
    
    if (!user) {
      return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    }
    
    // Toggle active
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { active: !user.active },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        active: true
      }
    });
    
    console.log(`✅ Usuario ${updatedUser.active ? 'activado' : 'desactivado'}:`, updatedUser.email);
    
    // Registrar actividad
    await logActivity({
      type: updatedUser.active ? 'user_activated' : 'user_deactivated',
      description: `Usuario ${updatedUser.name} fue ${updatedUser.active ? 'activado' : 'desactivado'} por ${req.user.name}`,
      userId: req.user.id,
      metadata: {
        affectedUserId: updatedUser.id,
        affectedUserEmail: updatedUser.email,
        newStatus: updatedUser.active,
        actionBy: req.user.email
      }
    });
    
    res.json({ ok: true, user: updatedUser });
    
  } catch (e) {
    console.error('❌ Error cambiando estado de usuario:', e);
    res.status(500).json({ ok: false, error: 'Error en el servidor' });
  }
});

// ============================================
// ENDPOINTS DE FIRMAS DE USUARIOS
// ============================================

/**
 * POST /api/users/:id/signature
 * Subir firma para un usuario (solo el mismo usuario o admin)
 */
app.post('/api/users/:id/signature', requireAuth, uploadSignature.single('signature'), async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No se proporcionó archivo' });
    }
    
    // Verificar permisos: solo el mismo usuario o admin
    if (req.user.id !== userId && req.user.role !== 'admin') {
      // Eliminar archivo subido
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ ok: false, error: 'No tienes permiso para modificar esta firma' });
    }
    
    console.log('🖊️ Subiendo firma:', {
      userId,
      filename: req.file.filename,
      size: req.file.size
    });
    
    // Verificar que el usuario existe
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });
    
    if (!user) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    }
    
    // Si el usuario ya tiene una firma, eliminar la anterior
    if (user.signature) {
      const oldSignaturePath = path.join(SIGNATURES_DIR, user.signature);
      if (fs.existsSync(oldSignaturePath)) {
        fs.unlinkSync(oldSignaturePath);
        console.log('🗑️ Firma anterior eliminada:', user.signature);
      }
    }
    
    // Actualizar usuario con el nombre de la nueva firma
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { signature: req.file.filename },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        signature: true
      }
    });
    
    console.log('✅ Firma guardada:', req.file.filename);
    
    res.json({
      ok: true,
      filename: req.file.filename,
      url: `/signatures/${req.file.filename}`,
      user: updatedUser
    });
    
  } catch (e) {
    console.error('❌ Error subiendo firma:', e);
    
    // Limpiar archivo si hubo error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * DELETE /api/users/:id/signature
 * Eliminar firma de un usuario
 */
app.delete('/api/users/:id/signature', requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    
    // Verificar permisos
    if (req.user.id !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ ok: false, error: 'No tienes permiso' });
    }
    
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });
    
    if (!user) {
      return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    }
    
    if (!user.signature) {
      return res.status(400).json({ ok: false, error: 'El usuario no tiene firma' });
    }
    
    // Eliminar archivo físico
    const signaturePath = path.join(SIGNATURES_DIR, user.signature);
    if (fs.existsSync(signaturePath)) {
      fs.unlinkSync(signaturePath);
      console.log('🗑️ Archivo eliminado:', user.signature);
    }
    
    // Actualizar usuario
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { signature: null },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        signature: true
      }
    });
    
    console.log('✅ Firma eliminada del usuario:', user.name);
    
    res.json({ ok: true, user: updatedUser });
    
  } catch (e) {
    console.error('❌ Error eliminando firma:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// GUARDAR CONFIG DE CORREO DEL USUARIO
// ============================================
app.put('/api/users/:id/email-config', requireAuth, async (req, res) => {
  try {
    const { emailFrom, emailPassword } = req.body;
    const id = parseInt(req.params.id);

    if (req.user.id !== id && req.user.role !== 'admin') {
      return res.status(403).json({ ok: false, error: 'Sin permisos' });
    }

    await prisma.user.update({
      where: { id },
      data: { emailFrom, emailPassword }
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/users/:id/signature
 * Obtener URL de la firma
 */
app.get('/api/users/:id/signature', requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, signature: true }
    });
    
    if (!user) {
      return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    }
    
    if (!user.signature) {
      return res.status(404).json({ ok: false, error: 'El usuario no tiene firma' });
    }
    
    // Verificar que el archivo existe
    const signaturePath = path.join(SIGNATURES_DIR, user.signature);
    if (!fs.existsSync(signaturePath)) {
      return res.status(404).json({ ok: false, error: 'Archivo de firma no encontrado' });
    }
    
    res.json({
      ok: true,
      filename: user.signature,
      url: `/signatures/${user.signature}`,
      user: user
    });
    
  } catch (e) {
    console.error('❌ Error obteniendo firma:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/////////////////////////////////////////////////////////////////
// ENDPOINTS PAPELERA VENTAS //
app.delete('/api/sales/:id', requireAuth, async (req, res) => {
  try {
    await prisma.sale.update({
      where: { id: parseInt(req.params.id) },
      data: { deletedAt: new Date() }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/trash/sales', requireAuth, async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 20;
    const search = req.query.search || '';

    const where = {
      deletedAt: { not: null },
      OR: search ? [
        { folio: { contains: search, mode: 'insensitive' } },
        { client: { name: { contains: search, mode: 'insensitive' } } }
      ] : undefined
    };

    const [sales, total] = await Promise.all([
      prisma.sale.findMany({
        where,
        include: { client: true, quote: true },
        orderBy: { deletedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit
      }),
      prisma.sale.count({ where })
    ]);

    res.json({ ok: true, sales, pagination: { page, pages: Math.ceil(total / limit), total } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/trash/sales/:id/restore', requireAuth, async (req, res) => {
  try {
    await prisma.sale.update({
      where: { id: parseInt(req.params.id) },
      data: { deletedAt: null }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/trash/sales/:id/permanent', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    // Eliminar registros relacionados primero
    await prisma.productionOrder.deleteMany({ where: { saleId: id } });
    await prisma.commission.deleteMany({ where: { saleId: id } });
    await prisma.saleItem.deleteMany({ where: { saleId: id } });
    await prisma.activity.deleteMany({ where: { saleId: id } });

    // Ahora sí eliminar la venta
    await prisma.sale.delete({ where: { id } });

    res.json({ ok: true });
  } catch (e) {
    console.error('❌ Error eliminando venta permanentemente:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/trash/sales/empty', requireAuth, async (req, res) => {
  try {
    const sales = await prisma.sale.findMany({
      where: { deletedAt: { not: null } },
      select: { id: true }
    });

    const ids = sales.map(s => s.id);

    await prisma.productionOrder.deleteMany({ where: { saleId: { in: ids } } });
    await prisma.commission.deleteMany({ where: { saleId: { in: ids } } });
    await prisma.saleItem.deleteMany({ where: { saleId: { in: ids } } });
    await prisma.activity.deleteMany({ where: { saleId: { in: ids } } });
    await prisma.sale.deleteMany({ where: { deletedAt: { not: null } } });

    res.json({ ok: true, count: ids.length });
  } catch (e) {
    console.error('❌ Error vaciando ventas:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// ENDPOINTS DE REPORTES DE VENTAS
// ============================================

/**
 * POST /api/reports/generate
 * Genera un reporte de ventas mensual en Excel
 * 
 * Body: { month: 2, year: 2026 }
 * Response: Descarga del archivo Excel
 */
app.post('/api/reports/generate', requireAuth, async (req, res) => {
  try {
    const { month, year } = req.body;

    console.log('📊 [POST /api/reports/generate] Generando reporte:', { month, year });

    // Validaciones
    if (!month || !year) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Mes y año son requeridos' 
      });
    }

    const mesNum = parseInt(month);
    const añoNum = parseInt(year);

    if (mesNum < 1 || mesNum > 12) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Mes inválido (debe ser 1-12)' 
      });
    }

    if (añoNum < 2020 || añoNum > 2030) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Año inválido' 
      });
    }

    // Generar reporte
    const filePath = await generarReporteMensual(mesNum, añoNum, req.user.id);

    console.log('  ✅ Reporte generado:', filePath);

    // Enviar archivo para descarga
    const nombreDescarga = `Reporte_Ventas_${añoNum}_${String(mesNum).padStart(2, '0')}.xlsx`;

    res.download(filePath, nombreDescarga, (err) => {
      if (err) {
        console.error('  ❌ Error descargando archivo:', err);
        if (!res.headersSent) {
          res.status(500).json({ 
            ok: false, 
            error: 'Error descargando archivo' 
          });
        }
      } else {
        console.log('  ✅ Archivo descargado correctamente');
      }
    });

  } catch (error) {
    console.error('❌ Error generando reporte:', error);
    res.status(500).json({ 
      ok: false, 
      error: error.message || 'Error generando reporte' 
    });
  }
});

/**
 * GET /api/reports
 * Obtiene la lista de reportes generados
 * 
 * Query params: ?year=2026&month=2&reportType=monthly
 * Response: { ok: true, reports: [...] }
 */
app.get('/api/reports', requireAuth, async (req, res) => {
  try {
    const { year, month, reportType } = req.query;

    console.log('📋 [GET /api/reports] Obteniendo reportes:', { year, month, reportType });

    const reportes = await obtenerReportes({
      year,
      month,
      reportType
    });

    console.log(`  ✅ ${reportes.length} reportes encontrados`);

    res.json({ 
      ok: true, 
      reports: reportes 
    });

  } catch (error) {
    console.error('❌ Error obteniendo reportes:', error);
    res.status(500).json({ 
      ok: false, 
      error: 'Error obteniendo reportes' 
    });
  }
});

/**
 * GET /api/reports/:id/download
 * Descarga un reporte específico por ID
 * 
 * Response: Descarga del archivo Excel
 */
app.get('/api/reports/:id/download', requireAuth, async (req, res) => {
  try {
    const reportId = parseInt(req.params.id);

    console.log('📥 [GET /api/reports/:id/download] Descargando reporte:', reportId);

    const reporte = await prisma.salesReport.findUnique({
      where: { id: reportId }
    });

    if (!reporte) {
      return res.status(404).json({ 
        ok: false, 
        error: 'Reporte no encontrado' 
      });
    }

    console.log('  ✅ Reporte encontrado:', reporte.filePath);

    // Verificar que el archivo existe
    const fs = require('fs');
    if (!fs.existsSync(reporte.filePath)) {
      return res.status(404).json({ 
        ok: false, 
        error: 'Archivo no encontrado' 
      });
    }

    // Generar nombre de descarga
    const nombreDescarga = `Reporte_Ventas_${reporte.year}_${String(reporte.month).padStart(2, '0')}.xlsx`;

    res.download(reporte.filePath, nombreDescarga);

  } catch (error) {
    console.error('❌ Error descargando reporte:', error);
    res.status(500).json({ 
      ok: false, 
      error: 'Error descargando reporte' 
    });
  }
});

console.log('✅ Endpoints de reportes de ventas configurados');


// ============================================
// REPORTS API (Exportes a Excel)
// ============================================

// REPORTE 1: COTIZACIONES
app.get('/api/reports/quotes', async (req, res) => {
  try {
    const { dateFrom, dateTo, status, search } = req.query;
    
    console.log('📊 Generando reporte de cotizaciones:', {
      dateFrom, dateTo, status, search
    });
    
    // Construir filtros
    const where = {};
    
    if (search) {
      where.OR = [
        { folio: { contains: search, mode: 'insensitive' } },
        { client: { name: { contains: search, mode: 'insensitive' } } },
        { client: { company: { contains: search, mode: 'insensitive' } } }
      ];
    }
    
    if (status) where.status = status;
    
    if (dateFrom || dateTo) {
      where.date = {};
      if (dateFrom) where.date.gte = new Date(dateFrom);
      if (dateTo) {
        const toDate = new Date(dateTo);
        toDate.setHours(23, 59, 59, 999);
        where.date.lte = toDate;
      }
    }
    
    // Obtener cotizaciones
    const quotes = await prisma.quote.findMany({
      where,
      include: {
        client: true,
        items: {
          include: { product: true }
        }
      },
      orderBy: { date: 'desc' }
    });
    
    console.log(`✅ ${quotes.length} cotizaciones encontradas`);
    
    // Crear workbook
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Cotizaciones');
    
    // TÍTULO
    worksheet.mergeCells('A1:M1');
    const titleCell = worksheet.getCell('A1');
    titleCell.value = '📋 REPORTE DE COTIZACIONES';
    titleCell.font = { size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF62E41' } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
    worksheet.getRow(1).height = 35;
    
    // FILTROS APLICADOS
    worksheet.addRow([]);
    const filtersRow = worksheet.addRow(['FILTROS APLICADOS:']);
    filtersRow.font = { bold: true, size: 11 };
    
    if (dateFrom || dateTo) {
      worksheet.addRow(['Rango de fechas:', 
        `${dateFrom ? new Date(dateFrom).toLocaleDateString('es-MX') : 'Inicio'} - ${dateTo ? new Date(dateTo).toLocaleDateString('es-MX') : 'Fin'}`
      ]);
    }
    if (status) worksheet.addRow(['Estado:', status.toUpperCase()]);
    if (search) worksheet.addRow(['Búsqueda:', search]);
    
    worksheet.addRow([]);
    worksheet.addRow(['Fecha de generación:', new Date().toLocaleString('es-MX')]);
    worksheet.addRow(['Total de cotizaciones:', quotes.length]);
    worksheet.addRow([]);
    
    // ENCABEZADOS
    const headerRow = worksheet.addRow([
      'FOLIO',
      'FECHA',
      'CLIENTE',
      'EMPRESA',
      'ESTADO',
      'SUBTOTAL',
      'DESCUENTO',
      'IMPUESTOS',
      'TOTAL USD',
      'TOTAL MXN',
      'T/C',
      'T. ENTREGA',
      'FORMA PAGO'
    ]);
    
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF333333' } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    headerRow.height = 25;
    
    // DATOS
    quotes.forEach(quote => {
      const row = worksheet.addRow([
        quote.folio,
        quote.date ? new Date(quote.date).toLocaleDateString('es-MX') : '',
        quote.client?.name || 'Sin cliente',
        quote.client?.company || '',
        quote.status.toUpperCase(),
        parseFloat(quote.subtotal) || 0,
        parseFloat(quote.discount) || 0,
        parseFloat(quote.tax) || 0,
        parseFloat(quote.total) || 0,
        parseFloat(quote.netMxn) || 0,
        parseFloat(quote.exchangeRate) || 0,
        quote.tiempoEntrega || '',
        quote.formaPago || ''
      ]);
      
      // Formato de moneda
      row.getCell(6).numFmt = '"$"#,##0.00';
      row.getCell(7).numFmt = '"$"#,##0.00';
      row.getCell(8).numFmt = '"$"#,##0.00';
      row.getCell(9).numFmt = '"$"#,##0.00';
      row.getCell(10).numFmt = '"$"#,##0.00';
      row.getCell(11).numFmt = '#,##0.0000';
      
      // Color según estado
      if (quote.status === 'convertida') {
        row.getCell(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD4EDDA' } };
        row.getCell(5).font = { color: { argb: 'FF155724' }, bold: true };
      } else if (quote.status === 'vencida') {
        row.getCell(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8D7DA' } };
        row.getCell(5).font = { color: { argb: 'FF721C24' }, bold: true };
      }
    });
    
    // ANCHOS DE COLUMNAS
    worksheet.columns = [
      { key: 'folio', width: 18 },
      { key: 'fecha', width: 12 },
      { key: 'cliente', width: 25 },
      { key: 'empresa', width: 30 },
      { key: 'estado', width: 12 },
      { key: 'subtotal', width: 15 },
      { key: 'descuento', width: 15 },
      { key: 'impuestos', width: 15 },
      { key: 'totalUsd', width: 15 },
      { key: 'totalMxn', width: 15 },
      { key: 'tc', width: 12 },
      { key: 'tiempoEntrega', width: 20 },
      { key: 'formaPago', width: 25 }
    ];
    
    // TOTALES
    worksheet.addRow([]);
    const totalsRow = worksheet.addRow([
      '', '', '', '', 'TOTALES:',
      quotes.reduce((sum, q) => sum + (parseFloat(q.subtotal) || 0), 0),
      quotes.reduce((sum, q) => sum + (parseFloat(q.discount) || 0), 0),
      quotes.reduce((sum, q) => sum + (parseFloat(q.tax) || 0), 0),
      quotes.reduce((sum, q) => sum + (parseFloat(q.total) || 0), 0),
      quotes.reduce((sum, q) => sum + (parseFloat(q.netMxn) || 0), 0)
    ]);
    
    totalsRow.font = { bold: true, size: 12 };
    totalsRow.getCell(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
    totalsRow.getCell(6).numFmt = '"$"#,##0.00';
    totalsRow.getCell(7).numFmt = '"$"#,##0.00';
    totalsRow.getCell(8).numFmt = '"$"#,##0.00';
    totalsRow.getCell(9).numFmt = '"$"#,##0.00';
    totalsRow.getCell(10).numFmt = '"$"#,##0.00';
    
    // HOJA 2: DETALLE DE PRODUCTOS
    const detailSheet = workbook.addWorksheet('Detalle de Productos');
    
    detailSheet.mergeCells('A1:F1');
    const detailTitle = detailSheet.getCell('A1');
    detailTitle.value = '📦 PRODUCTOS POR COTIZACIÓN';
    detailTitle.font = { size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
    detailTitle.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6C757D' } };
    detailTitle.alignment = { vertical: 'middle', horizontal: 'center' };
    detailSheet.getRow(1).height = 30;
    
    detailSheet.addRow([]);
    
    const detailHeader = detailSheet.addRow([
      'FOLIO',
      'MODELO',
      'DESCRIPCIÓN',
      'CANTIDAD',
      'PRECIO UNIT.',
      'SUBTOTAL'
    ]);
    
    detailHeader.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    detailHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6C757D' } };
    detailHeader.alignment = { vertical: 'middle', horizontal: 'center' };
    
    quotes.forEach(quote => {
      quote.items.forEach(item => {
        const row = detailSheet.addRow([
          quote.folio,
          item.modelo,
          item.descripcion || '',
          parseInt(item.qty) || 0,
          parseFloat(item.unitPrice) || 0,
          parseFloat(item.subtotal) || 0
        ]);
        
        row.getCell(5).numFmt = '"$"#,##0.00';
        row.getCell(6).numFmt = '"$"#,##0.00';
      });
    });
    
    detailSheet.columns = [
      { key: 'folio', width: 18 },
      { key: 'modelo', width: 20 },
      { key: 'descripcion', width: 40 },
      { key: 'cantidad', width: 12 },
      { key: 'precioUnit', width: 15 },
      { key: 'subtotal', width: 15 }
    ];
    
    // ENVIAR ARCHIVO
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=reporte_cotizaciones_${new Date().toISOString().split('T')[0]}.xlsx`);
    
    await workbook.xlsx.write(res);
    res.end();
    
    console.log('✅ Reporte de cotizaciones generado exitosamente');
    
  } catch (e) {
    console.error('❌ Error generando reporte de cotizaciones:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// REPORTE 2: VENTAS
app.get('/api/reports/sales', async (req, res) => {
  try {
    const { dateFrom, dateTo, paymentStatus, deliveryStatus } = req.query;
    
    console.log('💰 Generando reporte de ventas:', {
      dateFrom, dateTo, paymentStatus, deliveryStatus
    });
    
    // Construir filtros
    const where = {};
    
    if (paymentStatus) where.paymentStatus = paymentStatus;
    if (deliveryStatus) where.deliveryStatus = deliveryStatus;
    
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom);
      if (dateTo) {
        const toDate = new Date(dateTo);
        toDate.setHours(23, 59, 59, 999);
        where.createdAt.lte = toDate;
      }
    }
    
    // Obtener ventas
    const sales = await prisma.sale.findMany({
      where,
      include: {
        client: true,
        quote: true,
        items: {
          include: { product: true }
        },
        productionOrders: true
      },
      orderBy: { createdAt: 'desc' }
    });
    
    console.log(`✅ ${sales.length} ventas encontradas`);
    
    // Crear workbook
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Ventas');
    
    // TÍTULO
    worksheet.mergeCells('A1:L1');
    const titleCell = worksheet.getCell('A1');
    titleCell.value = '💰 REPORTE DE VENTAS';
    titleCell.font = { size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF10B981' } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
    worksheet.getRow(1).height = 35;
    
    // FILTROS
    worksheet.addRow([]);
    worksheet.addRow(['FILTROS APLICADOS:']).font = { bold: true, size: 11 };
    
    if (dateFrom || dateTo) {
      worksheet.addRow(['Rango de fechas:', 
        `${dateFrom ? new Date(dateFrom).toLocaleDateString('es-MX') : 'Inicio'} - ${dateTo ? new Date(dateTo).toLocaleDateString('es-MX') : 'Fin'}`
      ]);
    }
    if (paymentStatus) worksheet.addRow(['Estado de pago:', paymentStatus.toUpperCase()]);
    if (deliveryStatus) worksheet.addRow(['Estado de entrega:', deliveryStatus.toUpperCase()]);
    
    worksheet.addRow([]);
    worksheet.addRow(['Fecha de generación:', new Date().toLocaleString('es-MX')]);
    worksheet.addRow(['Total de ventas:', sales.length]);
    worksheet.addRow([]);
    
    // ENCABEZADOS
    const headerRow = worksheet.addRow([
      'FOLIO VENTA',
      'FOLIO COTIZ.',
      'FECHA',
      'CLIENTE',
      'EMPRESA',
      'TOTAL USD',
      'TOTAL MXN',
      'ESTADO PAGO',
      'ESTADO ENTREGA',
      'ORDEN PROD.',
      'PRODUCTOS',
      'NOTAS'
    ]);
    
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF047857' } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    headerRow.height = 25;
    
    // DATOS
    sales.forEach(sale => {
      const row = worksheet.addRow([
        sale.folio,
        sale.quote?.folio || '',
        (sale.date || sale.createdAt).toLocaleDateString('es-MX'),
        sale.client?.name || 'Sin cliente',
        sale.client?.company || '',
        parseFloat(sale.total) || 0,
        parseFloat(sale.netMxn) || 0,
        sale.paymentStatus.toUpperCase(),
        sale.deliveryStatus.toUpperCase(),
        sale.productionOrders.length > 0 ? sale.productionOrders[0].folio : 'Sin OP',
        sale.items.length,
        ''
      ]);
      
      // Formato de moneda
      row.getCell(6).numFmt = '"$"#,##0.00';
      row.getCell(7).numFmt = '"$"#,##0.00';
      
      // Color según estado de pago
      if (sale.paymentStatus === 'pagado') {
        row.getCell(8).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD4EDDA' } };
        row.getCell(8).font = { color: { argb: 'FF155724' }, bold: true };
      } else if (sale.paymentStatus === 'pendiente') {
        row.getCell(8).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } };
        row.getCell(8).font = { color: { argb: 'FF856404' }, bold: true };
      }
      
      // Color según estado de entrega
      if (sale.deliveryStatus === 'entregado') {
        row.getCell(9).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD4EDDA' } };
        row.getCell(9).font = { color: { argb: 'FF155724' }, bold: true };
      } else if (sale.deliveryStatus === 'proceso') {
        row.getCell(9).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1ECF1' } };
        row.getCell(9).font = { color: { argb: 'FF0C5460' }, bold: true };
      }
    });
    
    // ANCHOS
    worksheet.columns = [
      { key: 'folioVenta', width: 18 },
      { key: 'folioCotiz', width: 18 },
      { key: 'fecha', width: 12 },
      { key: 'cliente', width: 25 },
      { key: 'empresa', width: 30 },
      { key: 'totalUsd', width: 15 },
      { key: 'totalMxn', width: 15 },
      { key: 'estadoPago', width: 18 },
      { key: 'estadoEntrega', width: 18 },
      { key: 'ordenProd', width: 18 },
      { key: 'productos', width: 12 },
      { key: 'notas', width: 30 }
    ];
    
    // TOTALES
    worksheet.addRow([]);
    const totalsRow = worksheet.addRow([
      '', '', '', '', 'TOTALES:',
      sales.reduce((sum, s) => sum + (parseFloat(s.total) || 0), 0),
      sales.reduce((sum, s) => sum + (parseFloat(s.netMxn) || 0), 0)
    ]);
    
    totalsRow.font = { bold: true, size: 12 };
    totalsRow.getCell(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
    totalsRow.getCell(6).numFmt = '"$"#,##0.00';
    totalsRow.getCell(7).numFmt = '"$"#,##0.00';
    
    // ENVIAR ARCHIVO
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=reporte_ventas_${new Date().toISOString().split('T')[0]}.xlsx`);
    
    await workbook.xlsx.write(res);
    res.end();
    
    console.log('✅ Reporte de ventas generado exitosamente');
    
  } catch (e) {
    console.error('❌ Error generando reporte de ventas:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// REPORTE 3: PRODUCTOS
app.get('/api/reports/products', async (req, res) => {
  try {
    const { search } = req.query;
    
    console.log('📦 Generando reporte de productos:', { search });
    
    // Construir filtros
    const where = search ? {
      OR: [
        { model: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } }
      ]
    } : {};
    
    // Obtener productos
    const products = await prisma.product.findMany({
      where,
      orderBy: { model: 'asc' }
    });
    
    console.log(`✅ ${products.length} productos encontrados`);
    
    // Crear workbook
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Productos');
    
    // TÍTULO
    worksheet.mergeCells('A1:E1');
    const titleCell = worksheet.getCell('A1');
    titleCell.value = '📦 CATÁLOGO DE PRODUCTOS';
    titleCell.font = { size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
    worksheet.getRow(1).height = 35;
    
    // INFO
    worksheet.addRow([]);
    if (search) {
      worksheet.addRow(['Búsqueda:', search]).font = { bold: true };
    }
    worksheet.addRow(['Fecha de generación:', new Date().toLocaleString('es-MX')]);
    worksheet.addRow(['Total de productos:', products.length]);
    worksheet.addRow([]);
    
    // ENCABEZADOS
    const headerRow = worksheet.addRow([
      'MODELO',
      'DESCRIPCIÓN',
      'PRECIO',
      'MONEDA',
      'FICHA TÉCNICA'
    ]);
    
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    headerRow.height = 25;
    
    // DATOS
    products.forEach(product => {
      const row = worksheet.addRow([
        product.model,
        product.description || '',
        parseFloat(product.price) || 0,
        product.currency,
        product.ficha || 'Sin ficha'
      ]);
      
      // Formato de moneda
      row.getCell(3).numFmt = '"$"#,##0.00';
    });
    
    // ANCHOS
    worksheet.columns = [
      { key: 'modelo', width: 25 },
      { key: 'descripcion', width: 50 },
      { key: 'precio', width: 15 },
      { key: 'moneda', width: 10 },
      { key: 'ficha', width: 30 }
    ];
    
    // ENVIAR ARCHIVO
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=reporte_productos_${new Date().toISOString().split('T')[0]}.xlsx`);
    
    await workbook.xlsx.write(res);
    res.end();
    
    console.log('✅ Reporte de productos generado exitosamente');
    
  } catch (e) {
    console.error('❌ Error generando reporte de productos:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GENERATE PDF FOR SALE
app.get('/api/sales/:id/pdf', async (req, res) => {
  try {
    const saleId = parseInt(req.params.id);
    
    const sale = await prisma.sale.findUnique({
      where: { id: saleId },
      include: {
        client: true,
        items: {
          include: { product: true }
        },
        quote: true
      }
    });
    
    if (!sale) {
      return res.status(404).json({ ok: false, error: 'Venta no encontrada' });
    }
    
    // Usar la plantilla de la cotización original si existe
    const template = sale.quote?.template || 'default-template.pdf';
    
    // Preparar datos para el PDF (formato esperado por generatePdfBuffer)
    const pdfData = {
      folio: sale.folio,
      fecha: (sale.date || sale.createdAt).toLocaleDateString('es-MX'),
      nombre: sale.client?.name || '',
      empresa: sale.client?.company || '',
      correo: sale.client?.email || '',
      numero: sale.client?.phone || '',
      estado: sale.client?.estado || '',
      subtotal: sale.subtotal?.toFixed(2) || '0.00',
      descuento: sale.discount?.toFixed(2) || '0.00',
      impuestos: sale.tax?.toFixed(2) || '0.00',
      total: sale.total?.toFixed(2) || '0.00',
      precio_neto_mxn_formatted: quote.netMxn ? (quote.netMxn.toFixed(2) + ' MXN') : '',

        // ⭐ AGREGAR CONDICIONES COMERCIALES
        tiempoEntrega: quote.tiempoEntrega || '',
        formaPago: quote.formaPago || '',
        items: sale.items.map(item => ({
        modelo: item.modelo,
        descripcion: item.descripcion,
        precio: item.unitPrice?.toFixed(2) || '0.00',
        cant: String(item.qty),
        subtotal: item.subtotal?.toFixed(2) || '0.00'
      }))
    };
    
    const pdfBuf = await generatePdfBuffer(template, pdfData);
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=venta_${sale.folio}.pdf`);
    res.send(Buffer.from(pdfBuf));
    
  } catch (e) {
    console.error('Error generating sale PDF:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// PDF GENERATION
// ============================================

function mergeFieldsTopLevel(data) {
  if (!data || typeof data !== 'object') return data;
  if (data.fields && typeof data.fields === 'object') {
    for (const k of Object.keys(data.fields)) {
      if (data[k] === undefined) data[k] = data.fields[k];
    }
  }
  return data;
}

async function generatePdfBuffer(templateFilename, data = {}, options = {}) {
  const safe = safeName(templateFilename);
  const templatePath = path.join(TEMPLATES_DIR, safe);
  if (!fs.existsSync(templatePath)) throw new Error('Plantilla no encontrada: ' + safe);

  // Función de sanitización (ya existente)
  function sanitizeText(text) {
    if (!text) return text;
    
    const replacements = {
      'Φ': 'F', 'φ': 'f', 'Ω': 'Ohm', 'μ': 'u', 'α': 'a', 'β': 'b',
      'γ': 'g', 'Δ': 'D', '°': 'deg', '±': '+/-', '×': 'x', '÷': '/',
      '≤': '<=', '≥': '>=', '≠': '!=', '™': '(TM)', '©': '(C)', '®': '(R)',
      '€': 'EUR', '£': 'GBP', '¥': 'YEN',
    };
    
    let sanitized = String(text);
    for (const [special, replacement] of Object.entries(replacements)) {
      sanitized = sanitized.replace(new RegExp(special, 'g'), replacement);
    }
    sanitized = sanitized.replace(/[^\x20-\x7E\xA0-\xFF\n\r]/g, '');
    return sanitized;
  }

  // ⭐ FUNCIÓN MEJORADA: Formatear valores monetarios
  function formatMoney(value, currency = 'USD') {
    if (!value && value !== 0) return '';
    
    const valueStr = String(value);
    
    // Si ya tiene formato completo, no modificar
    if (valueStr.includes('USD') || valueStr.includes('MXN')) {
      return sanitizeText(valueStr);
    }
    
    // Eliminar símbolos existentes y texto
    const cleanValue = valueStr.replace(/[^0-9.\-]/g, '');
    
    // Convertir a número
    const numValue = parseFloat(cleanValue);
    
    if (isNaN(numValue)) return sanitizeText(valueStr);
    
    // Formatear con comas y 2 decimales
    const formatted = Math.abs(numValue).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    
    // Agregar símbolo según moneda
    const symbol = '$';
    const sign = numValue < 0 ? '-' : '';
    
    return sanitizeText(`${sign}${symbol}${formatted} ${currency}`);
  }

  // ⭐ Primero hacer merge de fields
  data = mergeFieldsTopLevel(data || {});
  
  // ⭐ LISTA COMPLETA DE CAMPOS MONETARIOS
  const moneyFields = [
    'subtotal',
    'descuento',
    'impuestos',
    'total',
    'precio',
    'price',
    'unitPrice',
    'amount',
    'monto',
    'discount',
    'tax',
    'impuesto'
  ];
  
  // Obtener moneda (default USD)
  const currency = data.currency || 'USD';
  
  console.log('💰 Formateando campos monetarios con', currency);
  
  // ⭐ Sanitizar y formatear TODOS los campos (incluyendo los que vienen de fields)
  Object.keys(data).forEach(key => {
    const value = data[key];
    
    // Skip si es objeto, array o null/undefined
    if (!value || typeof value === 'object') return;
    
    const valueStr = String(value);
    
    // Si es un campo monetario, formatear con moneda
    if (moneyFields.includes(key.toLowerCase())) {
      data[key] = formatMoney(valueStr, currency);
      console.log(`  ✓ ${key}: ${data[key]}`);
    } else {
      data[key] = sanitizeText(valueStr);
    }
  });
  
  // ⭐ IMPORTANTE: También formatear dentro de data.fields si existe
  if (data.fields && typeof data.fields === 'object') {
    Object.keys(data.fields).forEach(key => {
      const value = data.fields[key];
      
      if (!value || typeof value === 'object') return;
      
      const valueStr = String(value);
      
      if (moneyFields.includes(key.toLowerCase())) {
        data.fields[key] = formatMoney(valueStr, currency);
        // También actualizar en data directamente
        data[key] = data.fields[key];
        console.log(`  ✓ fields.${key}: ${data.fields[key]}`);
      } else {
        data.fields[key] = sanitizeText(valueStr);
      }
    });
  }
  
// ⭐ Sanitizar y formatear items
if (data.items && Array.isArray(data.items)) {
  data.items = data.items.map(item => {
    // ⭐⭐⭐ AUTO-FIX: Agregar saltos de línea ANTES de sanitizar
    let descripcion = item.descripcion || '';
    
    if (descripcion && !descripcion.includes('\n')) {
      console.log('🔧 [AUTO-FIX] Agregando saltos de línea a:', item.modelo);
      
      descripcion = descripcion
        .replace(/(Modelo:|Funcionamiento:|Capacidad:|Sistema:|Voltaje de Entrada:|Voltaje de Salida:|Uso:|Entrada:|Salida:|Corriente:|Frecuencia:|Potencia:|Dimensiones:|Peso:|Marca:|Tipo:)/gi, '\n$1')
        .replace(/([a-z0-9])([A-Z][a-z])/g, '$1\n$2')
        .trim();
      
      console.log('  ✅ Después:', descripcion.substring(0, 100) + '...');
    }
    
    // ⭐ AHORA SÍ sanitizar (preservando \n)
    const formattedItem = {
      ...item,
      modelo: sanitizeText(item.modelo),
      descripcion: sanitizeText(descripcion), // ⭐ sanitizeText YA preserva \n
    };
    
    // Formatear todos los campos monetarios del item
    if (item.precio) formattedItem.precio = formatMoney(item.precio, currency);
    if (item.unitPrice) formattedItem.unitPrice = formatMoney(item.unitPrice, currency);
    if (item.subtotal) formattedItem.subtotal = formatMoney(item.subtotal, currency);
    if (item.price) formattedItem.price = formatMoney(item.price, currency);
    
    return formattedItem;
  });
}

  // ⭐ CASOS ESPECIALES: precio_neto_mxn
  if (data.precio_neto_mxn && !String(data.precio_neto_mxn).includes('MXN')) {
    data.precio_neto_mxn = formatMoney(data.precio_neto_mxn, 'MXN');
    console.log(`  ✓ precio_neto_mxn: ${data.precio_neto_mxn}`);
  }
  
  if (data.precio_neto_mxn_formatted && !String(data.precio_neto_mxn_formatted).includes('MXN')) {
    data.precio_neto_mxn_formatted = formatMoney(data.precio_neto_mxn_formatted, 'MXN');
    console.log(`  ✓ precio_neto_mxn_formatted: ${data.precio_neto_mxn_formatted}`);
  }

  console.log('✅ Formateo completado\n');

  data = mergeFieldsTopLevel(data || {});

  const existingPdfBytes = fs.readFileSync(templatePath);
  const pdfDoc = await PDFDocument.load(existingPdfBytes);
  const pages = pdfDoc.getPages();
  
  // ✅ CARGAR FUENTES (Normal y Bold)
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // ✅ CARGAR CALIBRACIÓN DESDE ARCHIVO
  const calib = loadCalibrationForTemplate(safe) || { pages: {} };
  const globalOffsetY = Number(calib.globalOffsetY || 0);

  console.log('📄 Generando PDF multi-página:', {
    template: safe,
    totalPages: pages.length,
    calibratedPages: Object.keys(calib.pages || {}).length,
    fieldsTotal: Object.keys(calib.pages || {}).reduce((sum, pageNum) => {
      return sum + Object.keys(calib.pages[pageNum]?.fields || {}).length;
    }, 0)
  });

  // Copiar valores a campos duplicados
  if (calib && calib.fields) {
    Object.keys(calib.fields).forEach(fieldName => {
      const copyMatch = fieldName.match(/^(.+)_(copy|2|3|4|5|bis|alt)$/);
      if (copyMatch) {
        const originalFieldName = copyMatch[1];
        if (!data[fieldName] && data[originalFieldName]) {
          data[fieldName] = data[originalFieldName];
          console.log(`✅ Copiado: ${originalFieldName} -> ${fieldName} = "${data[originalFieldName]}"`);
        }
      }
    });
  }

  // ✅ FUNCIÓN PARA DIVIDIR TEXTO EN LÍNEAS CON JUSTIFICACIÓN Y SALTOS DE LÍNEA
function wrapText(text, maxWidthPts, fontSize, fontToUse, justify = false) {
  if (!text) return [];
  
  const textStr = String(text);
  
  // ⭐ PRIMERO: Dividir por saltos de línea explícitos (\n)
  const paragraphs = textStr.split('\n');
  const allLines = [];
  
  paragraphs.forEach(paragraph => {
    // Si el párrafo está vacío, agregar línea vacía
    if (!paragraph.trim()) {
      allLines.push('');
      return;
    }
    
    // Procesar cada párrafo normalmente
    const words = paragraph.split(' ');
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine ? currentLine + ' ' + word : word;
      const testWidth = fontToUse.widthOfTextAtSize(testLine, fontSize);
      
      if (testWidth <= maxWidthPts) {
        currentLine = testLine;
      } else {
        if (currentLine) {
          allLines.push(currentLine);
          currentLine = word;
        } else {
          // Palabra muy larga, forzar división
          allLines.push(word);
          currentLine = '';
        }
      }
    }
    
    if (currentLine) {
      allLines.push(currentLine);
    }
  });
  
  return allLines;
}

  // ✅ FUNCIÓN PARA DIBUJAR TEXTO JUSTIFICADO
  function drawJustifiedLine(line, xStart, yDraw, maxWidthPts, fontSize, fontToUse, page) {
    const words = line.split(' ');
    
    if (words.length === 1) {
      // Una sola palabra, dibujar normal
      page.drawText(line, { x: xStart, y: yDraw, size: fontSize, font: fontToUse });
      return;
    }
    
    // Calcular ancho total del texto sin espacios
    let totalTextWidth = 0;
    words.forEach(word => {
      totalTextWidth += fontToUse.widthOfTextAtSize(word, fontSize);
    });
    
    // Calcular espacio entre palabras
    const totalSpaces = words.length - 1;
    const spaceWidth = (maxWidthPts - totalTextWidth) / totalSpaces;
    
    // Dibujar cada palabra con el espacio calculado
    let currentX = xStart;
    words.forEach((word, index) => {
      page.drawText(word, { x: Math.round(currentX), y: yDraw, size: fontSize, font: fontToUse });
      currentX += fontToUse.widthOfTextAtSize(word, fontSize);
      if (index < words.length - 1) {
        currentX += spaceWidth;
      }
    });
  }

  function drawTextWithAnchor(text, coord, optionsLocal = {}, page) {
    if (!coord || typeof coord.x !== 'number' || typeof coord.y !== 'number') return;
    if (!page) return;
    const { width, height } = page.getSize();
    
    const anchor = coord.anchor || 'left';
    const vAnchor = coord.vAnchor || 'baseline';
    const fontSize = Number(coord.fontSize) || 10;
    const isBold = coord.bold === true || coord.bold === 'true'; // ✅ DETECTAR NEGRITAS
    const isJustified = coord.justify === true || coord.justify === 'true'; // ✅ DETECTAR JUSTIFICADO
    
    // ✅ SELECCIONAR FUENTE (Normal o Bold)
    const fontToUse = isBold ? fontBold : font;
    
    // ✅ APLICAR OFFSETS CORRECTAMENTE
    const xPercWithOffset = coord.x + (Number(coord.offsetX) || 0);
    const yPercWithOffset = coord.y + (Number(coord.offsetY) || 0) + globalOffsetY;
    
    const xPts = width * xPercWithOffset;
    const yPts = height * yPercWithOffset;

    const textStr = (text === undefined || text === null) ? '' : String(text);
    
    // ✅ OBTENER DIMENSIONES DEL CAMPO
    const fieldWidthFrac = Number(coord.widthFrac) || 0;
    const fieldHeightFrac = Number(coord.heightFrac) || 0;
    const maxWidthPts = width * fieldWidthFrac;
    const maxHeightPts = height * fieldHeightFrac;
    
    // ✅ SI EL CAMPO TIENE DIMENSIONES, APLICAR WRAPPING
    let lines = [];
    if (fieldWidthFrac > 0 && textStr.length > 0) {
      lines = wrapText(textStr, maxWidthPts, fontSize, fontToUse, isJustified);
      console.log(`📝 Wrapping "${textStr.substring(0, 30)}..." → ${lines.length} líneas (maxWidth: ${maxWidthPts.toFixed(0)}pts) ${isBold ? '**BOLD**' : ''} ${isJustified ? '[JUSTIFIED]' : ''}`);
    } else {
      lines = [textStr];
    }

    // ✅ CALCULAR ALTURA DE LÍNEA
    const lineHeightPts = fontSize * 1.2;
    const totalTextHeight = lines.length * lineHeightPts;
    
    // ✅ LIMITAR LÍNEAS SI EXCEDEN LA ALTURA DEL CAMPO
    let maxLines = lines.length;
    if (fieldHeightFrac > 0) {
      maxLines = Math.floor(maxHeightPts / lineHeightPts);
      if (maxLines < 1) maxLines = 1;
      if (lines.length > maxLines) {
        console.warn(`⚠️ Texto truncado: ${lines.length} líneas → ${maxLines} líneas (altura máxima)`);
        lines = lines.slice(0, maxLines);
        if (lines[lines.length - 1]) {
          lines[lines.length - 1] = lines[lines.length - 1].substring(0, lines[lines.length - 1].length - 3) + '...';
        }
      }
    }

    // ✅ DIBUJAR CADA LÍNEA
    lines.forEach((line, index) => {
      let textWidth = 0;
      try { 
        textWidth = fontToUse.widthOfTextAtSize(line, fontSize);
      } catch (e) { 
        textWidth = 0; 
      }

      // Calcular posición X según anchor
      let xDraw;
      if (anchor === 'center') {
        xDraw = Math.round(xPts - (textWidth / 2));
      } else if (anchor === 'right') {
        xDraw = Math.round(xPts - textWidth);
      } else {
        xDraw = Math.round(xPts);
      }

      // Calcular posición Y según vAnchor y línea
      let yDraw;
      const lineOffset = index * lineHeightPts;
      
      if (vAnchor === 'top') {
        yDraw = Math.round(yPts - fontSize * 0.8 - lineOffset);
      } else if (vAnchor === 'baseline') {
        yDraw = Math.round(yPts - lineOffset);
      } else if (vAnchor === 'center') {
        const blockOffsetY = (totalTextHeight / 2) - (fontSize * 0.35);
        yDraw = Math.round(yPts - blockOffsetY - lineOffset);
      } else {
        yDraw = Math.round(yPts - lineOffset);
      }

      if (yDraw < 0) yDraw = 0;

      // ✅ DIBUJAR LÍNEA (JUSTIFICADA O NORMAL)
      const isLastLine = index === lines.length - 1;

      // ✅ boldFirstBlock: negritas hasta la primera línea vacía
      let lineFont = fontToUse;
      if (optionsLocal.boldFirstBlock) {
        const firstEmptyIndex = lines.findIndex(l => l.trim() === '');
        const boldUntil = firstEmptyIndex >= 0 ? firstEmptyIndex : lines.length;
        lineFont = index < boldUntil ? fontBold : font;
      }

      if (isJustified && !isLastLine && fieldWidthFrac > 0) {
        // Texto justificado (excepto última línea)
        drawJustifiedLine(line, xDraw, yDraw, maxWidthPts, fontSize, lineFont, page);
      } else {
        // Texto normal
        if (xDraw < 0) xDraw = 0;
        page.drawText(line, { x: xDraw, y: yDraw, size: fontSize, font: lineFont });
      }
    });

    // ✅ DEBUG: Dibujar rectángulo del campo
    if (optionsLocal.debug && fieldWidthFrac > 0 && fieldHeightFrac > 0) {
      const rawX = width * coord.x;
      const rawY = height * coord.y;
      
      page.drawRectangle({ 
        x: Math.round(xPts), 
        y: Math.round(yPts - maxHeightPts), 
        width: Math.round(maxWidthPts), 
        height: Math.round(maxHeightPts),
        borderColor: rgb(0, 0, 1),
        borderWidth: 1
      });
      
      page.drawRectangle({ 
        x: Math.round(rawX - 3), 
        y: Math.round(rawY - 3), 
        width: 6, 
        height: 6, 
        color: rgb(1, 0, 0) 
      });
      
      if (optionsLocal.label) {
        const lblSize = Math.max(6, Math.min(8, fontSize * 0.7));
        try { 
          page.drawText(optionsLocal.label, { 
            x: Math.round(rawX + 6), 
            y: Math.round(rawY - 3), 
            size: lblSize, 
            font: font // Siempre normal para labels
          }); 
        } catch(e){}
      }
    }
  }

  // ... (resto del código continúa igual - procesar items, dibujar campos, etc.)
  
  // Procesar items
// Procesar items
  let items = [];
  if (data.items) {
    try { 
      items = typeof data.items === 'string' ? JSON.parse(data.items) : data.items; 
    } catch (e) { 
      items = []; 
    }
  }

    // ========================================
    // ⭐ DIBUJAR EN TODAS LAS PÁGINAS
    // ========================================

    for (const pageNumStr of Object.keys(calib.pages || {})) {
      const pageNum = parseInt(pageNumStr);
      const pageIndex = pageNum - 1;
      
      if (pageIndex < 0 || pageIndex >= pages.length) {
        console.warn(`⚠️ Página ${pageNum} no existe en el PDF (total: ${pages.length} páginas)`);
        continue;
      }
      
      const page = pages[pageIndex];
      const { width, height } = page.getSize();
      const pageConfig = calib.pages[pageNumStr];
      
      // ✅ COPIAR VALORES A CAMPOS DUPLICADOS
      Object.keys(pageConfig.fields || {}).forEach(fieldName => {
        const copyMatch = fieldName.match(/^(.+)_(copy|2|3|4|5|bis|alt)$/);
        if (copyMatch) {
          const originalFieldName = copyMatch[1];
          if (!data[fieldName] && data[originalFieldName]) {
            data[fieldName] = data[originalFieldName];
            console.log(`✅ [Página ${pageNum}] Copiado: ${originalFieldName} -> ${fieldName} = "${data[originalFieldName]}"`);
          }
        }
      });
      
      console.log(`📝 Dibujando página ${pageNum}:`, {
        fields: Object.keys(pageConfig.fields || {}).length,
        size: `${width}x${height}pt`
      });
      
      // ✅ DIBUJAR CAMPOS NORMALES (no items, no firma)
      const drawn = new Set();
      
      Object.keys(pageConfig.fields || {}).forEach(fname => {
        if (fname.startsWith('item_')) return; // Los items se procesan después
        if (fname === 'firma') return; // ⭐ La firma se procesa después
        
        const coord = pageConfig.fields[fname];
        const value = (data && (data[fname] !== undefined)) ? data[fname] : '';
        
        drawTextWithAnchor(value, coord, { debug: options.debug, label: fname }, page);
        drawn.add(fname);
      });
      
      // ✅ DIBUJAR ITEMS (solo en páginas que tengan campos item_*)
      const hasItemFields = Object.keys(pageConfig.fields || {}).some(f => f.startsWith('item_'));
      
      if (hasItemFields && items.length > 0) {
        let modeloX = 0.05, descripcionX = 0.28, precioX = 0.68, cantX = 0.78, subtotalX = 0.88;
        let tableStartY = 0.61, lineHeight = 0.045;
        let itemFontSize = 9;

        if (pageConfig.fields['item_modelo']) {
          drawTextWithAnchor(item.modelo || '', baseCoordModelo, { debug: options.debug }, page);
        }
        if (pageConfig.fields['item_descripcion']) descripcionX = Number(pageConfig.fields['item_descripcion'].x);
        if (pageConfig.fields['item_precio']) precioX = Number(pageConfig.fields['item_precio'].x);
        if (pageConfig.fields['item_cant']) cantX = Number(pageConfig.fields['item_cant'].x);
        if (pageConfig.fields['item_subtotal']) subtotalX = Number(pageConfig.fields['item_subtotal'].x);
        
        if (pageConfig.table) {
          tableStartY = Number(pageConfig.table.startY) || tableStartY;
          lineHeight = Number(pageConfig.table.lineHeight) || lineHeight;
        }

        console.log(`📦 Dibujando ${items.length} items en página ${pageNum}`);

        // ⭐ Calcular altura dinámica por item según número de líneas
        const itemHeights = items.map(item => {
          const desc = item.descripcion || '';
          const modelo = item.modelo || '';
          const lineasDesc = desc ? desc.split('\n').length : 0;
          const lineasModelo = modelo ? modelo.split('\n').length : 1;
          const totalLineas = Math.max(lineasDesc, lineasModelo);
          return Math.max(lineHeight, totalLineas * (lineHeight * 0.39));
        });

        let acumuladoY = 0;
        items.forEach((item, i) => {
          const yPerc = tableStartY - acumuladoY;
          acumuladoY += itemHeights[i];
          if (yPerc <= 0) return;

          const baseCoordModelo = { 
            x: modeloX, y: yPerc, 
            anchor: pageConfig.fields['item_modelo']?.anchor || 'left',
            vAnchor: pageConfig.fields['item_modelo']?.vAnchor || 'center',
            fontSize: Number(pageConfig.fields['item_modelo']?.fontSize) || itemFontSize,
            offsetX: pageConfig.fields['item_modelo']?.offsetX || 0,
            offsetY: pageConfig.fields['item_modelo']?.offsetY || 0,
            widthFrac: Number(pageConfig.fields['item_modelo']?.widthFrac) || 0,
            heightFrac: Number(pageConfig.fields['item_modelo']?.heightFrac) || 0,
            bold: pageConfig.fields['item_modelo']?.bold || false,
            justify: false
          };
          
          const baseCoordDesc = { 
            x: descripcionX, y: yPerc,
            anchor: pageConfig.fields['item_descripcion']?.anchor || 'left',
            vAnchor: pageConfig.fields['item_descripcion']?.vAnchor || 'baseline',
            fontSize: Number(pageConfig.fields['item_descripcion']?.fontSize) || itemFontSize,
            offsetX: pageConfig.fields['item_descripcion']?.offsetX || 0,
            offsetY: pageConfig.fields['item_descripcion']?.offsetY || 0,
            widthFrac: Number(pageConfig.fields['item_descripcion']?.widthFrac) || 0,
            heightFrac: Number(pageConfig.fields['item_descripcion']?.heightFrac) || 0,
            bold: false,
            justify: pageConfig.fields['item_descripcion']?.justify || false
          };
          
          const baseCoordPrecio = { 
            x: precioX, y: yPerc,
            anchor: pageConfig.fields['item_precio']?.anchor || 'center',
            vAnchor: pageConfig.fields['item_precio']?.vAnchor || 'center',
            fontSize: Number(pageConfig.fields['item_precio']?.fontSize) || itemFontSize,
            offsetX: pageConfig.fields['item_precio']?.offsetX || 0,
            offsetY: pageConfig.fields['item_precio']?.offsetY || 0,
            widthFrac: Number(pageConfig.fields['item_precio']?.widthFrac) || 0,
            heightFrac: Number(pageConfig.fields['item_precio']?.heightFrac) || 0,
            bold: false,
            justify: false
          };
          
          const baseCoordCant = { 
            x: cantX, y: yPerc,
            anchor: pageConfig.fields['item_cant']?.anchor || 'left',
            vAnchor: pageConfig.fields['item_cant']?.vAnchor || 'baseline',
            fontSize: Number(pageConfig.fields['item_cant']?.fontSize) || itemFontSize,
            offsetX: pageConfig.fields['item_cant']?.offsetX || 0,
            offsetY: pageConfig.fields['item_cant']?.offsetY || 0,
            widthFrac: Number(pageConfig.fields['item_cant']?.widthFrac) || 0,
            heightFrac: Number(pageConfig.fields['item_cant']?.heightFrac) || 0,
            bold: false,
            justify: false
          };
          
          const baseCoordSubtotal = { 
            x: subtotalX, y: yPerc,
            anchor: pageConfig.fields['item_subtotal']?.anchor || 'center',
            vAnchor: pageConfig.fields['item_subtotal']?.vAnchor || 'center',
            fontSize: Number(pageConfig.fields['item_subtotal']?.fontSize) || itemFontSize,
            offsetX: pageConfig.fields['item_subtotal']?.offsetX || 0,
            offsetY: pageConfig.fields['item_subtotal']?.offsetY || 0,
            widthFrac: Number(pageConfig.fields['item_subtotal']?.widthFrac) || 0,
            heightFrac: Number(pageConfig.fields['item_subtotal']?.heightFrac) || 0,
            bold: false,
            justify: false
          };

          if (pageConfig.fields['item_modelo']) {
            drawTextWithAnchor(item.modelo || '', baseCoordModelo, { debug: options.debug }, page);
          }
          drawTextWithAnchor(item.descripcion || '', baseCoordDesc, { debug: options.debug, boldFirstBlock: true }, page);
          drawTextWithAnchor(item.precio || '', baseCoordPrecio, { debug: options.debug }, page);
          drawTextWithAnchor(item.cant || '1', baseCoordCant, { debug: options.debug }, page);
          drawTextWithAnchor(item.subtotal || '', baseCoordSubtotal, { debug: options.debug }, page);
        });
      }

      // ⭐⭐⭐ INSERTAR FIRMA USANDO CALIBRACIÓN ⭐⭐⭐
      if (data.userSignature && pageConfig.fields && pageConfig.fields['firma']) {
        try {
          const signaturePath = path.join(__dirname, 'public', 'signatures', data.userSignature);
          
          if (fs.existsSync(signaturePath)) {
            console.log(`🖊️ Insertando firma calibrada en página ${pageNum}: ${data.userSignature}`);
            
            const imageBytes = fs.readFileSync(signaturePath);
            const ext = path.extname(data.userSignature).toLowerCase();
            
            let signatureImage;
            if (ext === '.png') {
              signatureImage = await pdfDoc.embedPng(imageBytes);
            } else {
              signatureImage = await pdfDoc.embedJpg(imageBytes);
            }
            
            // ✅ USAR COORDENADAS DE CALIBRACIÓN
            const firmaCoord = pageConfig.fields['firma'];
            
            console.log(`  📍 Coordenadas de calibración:`, {
              x: firmaCoord.x,
              y: firmaCoord.y,
              offsetX: firmaCoord.offsetX,
              offsetY: firmaCoord.offsetY,
              widthFrac: firmaCoord.widthFrac,
              heightFrac: firmaCoord.heightFrac,
              anchor: firmaCoord.anchor,
              vAnchor: firmaCoord.vAnchor
            });
            
            // ⭐ CALCULAR POSICIÓN BASE (sin offsets todavía)
            const xBase = width * firmaCoord.x;
            const yBase = height * firmaCoord.y;
            
            // ⭐ CALCULAR DIMENSIONES DEL CAMPO
            const fieldWidthFrac = Number(firmaCoord.widthFrac) || 0.25;
            const fieldHeightFrac = Number(firmaCoord.heightFrac) || 0.1;
            
            const maxWidthPts = width * fieldWidthFrac;
            const maxHeightPts = height * fieldHeightFrac;
            
            // ⭐ CALCULAR DIMENSIONES DE LA IMAGEN (manteniendo aspect ratio)
            const imgAspectRatio = signatureImage.width / signatureImage.height;
            let drawWidth = maxWidthPts;
            let drawHeight = drawWidth / imgAspectRatio;
            
            if (drawHeight > maxHeightPts) {
              drawHeight = maxHeightPts;
              drawWidth = drawHeight * imgAspectRatio;
            }
            
            // ⭐ APLICAR ANCHOR HORIZONTAL
            let finalX = xBase;
            const anchor = firmaCoord.anchor || 'left';
            
            if (anchor === 'center') {
              finalX = xBase - (drawWidth / 2);
            } else if (anchor === 'right') {
              finalX = xBase - drawWidth;
            }
            // 'left' = no cambio
            
          // ⭐ APLICAR ANCHOR VERTICAL (CORRECCIÓN MEJORADA)
          const vAnchor = firmaCoord.vAnchor || 'baseline';
          let finalY = yBase; // ⭐ USAR DIRECTAMENTE yBase (ya está en coordenadas de página)

          if (vAnchor === 'top') {
            // Top significa que yBase es la PARTE SUPERIOR de la imagen
            // Como Y crece hacia arriba, restar la altura
            finalY = finalY - drawHeight;
          } else if (vAnchor === 'center') {
            // Center significa que yBase es el CENTRO de la imagen
            finalY = finalY - (drawHeight / 2);
          } else if (vAnchor === 'baseline' || vAnchor === 'bottom') {
            // Baseline/Bottom significa que yBase es la PARTE INFERIOR de la imagen
            // No hacer nada, finalY ya es correcto
          }

          // ⭐ APLICAR OFFSETS AL FINAL
          const offsetXPts = width * (Number(firmaCoord.offsetX) || 0);
          const offsetYPts = height * (Number(firmaCoord.offsetY) || 0);

          finalX += offsetXPts;
          finalY += offsetYPts; // ⭐ SUMAR porque Y crece hacia arriba en PDF

          // ⭐ APLICAR OFFSET GLOBAL
          finalY += height * globalOffsetY; // ⭐ SUMAR el offset global también
            
            // ⭐ DIBUJAR IMAGEN
            page.drawImage(signatureImage, {
              x: Math.round(finalX),
              y: Math.round(finalY),
              width: Math.round(drawWidth),
              height: Math.round(drawHeight)
            });
            
            console.log(`  ✅ Firma insertada:`, {
              posicion: `(${Math.round(finalX)}, ${Math.round(finalY)})`,
              dimensiones: `${Math.round(drawWidth)}x${Math.round(drawHeight)}px`,
              anchor: `${anchor} / ${vAnchor}`
            });
            
            // ✅ DEBUG: Dibujar rectángulo si está en modo debug
            if (options.debug) {
              // Rectángulo del área de la imagen
              page.drawRectangle({
                x: Math.round(finalX),
                y: Math.round(finalY),
                width: Math.round(drawWidth),
                height: Math.round(drawHeight),
                borderColor: rgb(0, 1, 0),
                borderWidth: 2
              });
              
              // Punto de anclaje (posición calibrada)
              const anchorX = xBase + offsetXPts;
              const anchorY = height - yBase - offsetYPts - (height * globalOffsetY);
              
              page.drawRectangle({
                x: Math.round(anchorX - 3),
                y: Math.round(anchorY - 3),
                width: 6,
                height: 6,
                color: rgb(1, 0, 0)
              });
              
              try {
                page.drawText('FIRMA', {
                  x: Math.round(finalX + 5),
                  y: Math.round(finalY + drawHeight + 5),
                  size: 8,
                  font: font,
                  color: rgb(0, 1, 0)
                });
                
                page.drawText(`${anchor}/${vAnchor}`, {
                  x: Math.round(anchorX + 5),
                  y: Math.round(anchorY + 5),
                  size: 6,
                  font: font,
                  color: rgb(1, 0, 0)
                });
              } catch (e) {}
            }
          } else {
            console.warn(`⚠️ Archivo de firma no encontrado: ${signaturePath}`);
          }
        } catch (e) {
          console.error(`❌ Error insertando firma:`, e.message);
          console.error(e.stack);
        }
      } else {
        // ⚠️ DEBUG: Por qué no se insertó la firma
        if (!data.userSignature) {
          console.log(`  ℹ️ Página ${pageNum}: Sin firma (data.userSignature no existe)`);
        } else if (!pageConfig.fields || !pageConfig.fields['firma']) {
          console.log(`  ℹ️ Página ${pageNum}: Sin campo 'firma' calibrado`);
        }
      }

    } // ⬅️ FIN DEL FOR LOOP

    // ============================================
    // ✅ GUARDAR PDF **DESPUÉS** DEL FOR LOOP
    // ============================================

    const pdfBytes = await pdfDoc.save();
    return pdfBytes;
}

app.post('/preview', async (req, res) => {
  try {
    const data = req.body;
    const templateName = data.template;
    
    if (!templateName) {
      return res.status(400).send('Template name required');
    }
    
    console.log('🔍 Preview solicitado para template:', templateName);
    
    // ⭐ OBTENER FIRMA DEL USUARIO
    let userSignature = null;
    if (req.user && req.user.id) {
      try {
        const user = await prisma.user.findUnique({
          where: { id: req.user.id },
          select: { signature: true }
        });
        userSignature = user?.signature || null;
      } catch (e) {
        console.warn('⚠️ No se pudo cargar firma del usuario');
      }
    }
    
    // ⭐ AGREGAR FIRMA AL DATA
    data.userSignature = userSignature;
    
    // ✅ GENERAR PDF BASE CON TU FUNCIÓN EXISTENTE
    const pdfBytes = await generatePdfBuffer(templateName, data, { debug: data.debug });
    
    // ✅ CARGAR EL PDF GENERADO PARA AGREGAR FICHAS
    const pdfDoc = await PDFDocument.load(pdfBytes);
    
    // ============================================
    // ⭐ AGREGAR FICHAS TÉCNICAS EN PÁGINA 2
    // ============================================
    
    if (data.items && data.items.length > 0) {
      const itemsWithFichas = [];
      
      // Buscar productos con fichas
      for (const item of data.items) {
        if (!item.modelo) continue;
        
        try {
          const product = await prisma.product.findFirst({
            where: { 
              model: {
                equals: item.modelo,
                mode: 'insensitive'
              }
            },
            select: { id: true, model: true, ficha: true }
          });
          
          if (product && product.ficha) {
            const fichaPath = path.join(FICHAS_DIR, product.ficha);
            
            if (fs.existsSync(fichaPath)) {
              itemsWithFichas.push({
                modelo: product.model,
                fichaPath: fichaPath,
                fichaFilename: product.ficha
              });
              
              console.log(`✅ Ficha encontrada: ${product.model} -> ${product.ficha}`);
            }
          }
        } catch (e) {
          console.warn(`⚠️ Error buscando ficha para ${item.modelo}:`, e.message);
        }
      }
      
      // Agregar fichas al PDF
      if (itemsWithFichas.length > 0) {
        console.log(`📎 Insertando ${itemsWithFichas.length} fichas en página 2...`);
        
        let insertPosition = 1; // Posición inicial (página 2 en índice base-0)
        
        for (const item of itemsWithFichas) {
          try {
            const fichaExt = path.extname(item.fichaFilename).toLowerCase();
            
            if (fichaExt === '.pdf') {
              // CASO 1: FICHA PDF - Insertar todas sus páginas en posición 2
              const fichaBytes = fs.readFileSync(item.fichaPath);
              const fichaPdf = await PDFDocument.load(fichaBytes);
              const fichaPages = await pdfDoc.copyPages(fichaPdf, fichaPdf.getPageIndices());
              
              // ⭐ INSERTAR en página 2 en lugar de agregar al final
              fichaPages.forEach((page, index) => {
                pdfDoc.insertPage(insertPosition + index, page);
              });
              
              insertPosition += fichaPages.length; // Actualizar posición para próxima ficha
              
              console.log(`  ✅ PDF insertado en página 2: ${item.fichaFilename} (${fichaPages.length} páginas)`);
              
            } else if (['.png', '.jpg', '.jpeg'].includes(fichaExt)) {
              // CASO 2: FICHA IMAGEN - Insertar en página 2
              const imageBytes = fs.readFileSync(item.fichaPath);
              let image;
              
              if (fichaExt === '.png') {
                image = await pdfDoc.embedPng(imageBytes);
              } else {
                image = await pdfDoc.embedJpg(imageBytes);
              }
              
              // ⭐ INSERTAR página en posición 2
              const newPage = pdfDoc.insertPage(insertPosition, [612, 792]);
              const pageWidth = newPage.getWidth();
              const pageHeight = newPage.getHeight();
              
              // Calcular dimensiones para llenar toda la página manteniendo aspect ratio
              const imgAspectRatio = image.width / image.height;
              const pageAspectRatio = pageWidth / pageHeight;
              
              let drawWidth, drawHeight, drawX, drawY;
              
              if (imgAspectRatio > pageAspectRatio) {
                // Imagen más ancha - ajustar al ancho
                drawWidth = pageWidth;
                drawHeight = drawWidth / imgAspectRatio;
                drawX = 0;
                drawY = (pageHeight - drawHeight) / 2;
              } else {
                // Imagen más alta - ajustar a la altura
                drawHeight = pageHeight;
                drawWidth = drawHeight * imgAspectRatio;
                drawX = (pageWidth - drawWidth) / 2;
                drawY = 0;
              }
              
              // Dibujar imagen a pantalla completa
              newPage.drawImage(image, {
                x: drawX,
                y: drawY,
                width: drawWidth,
                height: drawHeight
              });
              
              insertPosition++; // Actualizar posición para próxima ficha
              
              console.log(`  ✅ Imagen insertada en página 2: ${item.fichaFilename}`);
            }
            
          } catch (e) {
            console.error(`  ❌ Error procesando ficha ${item.fichaFilename}:`, e.message);
          }
        }
      }
    }
    
    // ============================================
    // CONFIGURACIÓN MULTER PARA FIRMAS DE USUARIOS
    // ============================================

    const SIGNATURES_DIR = path.join(__dirname, 'public', 'signatures');

    // Crear directorio si no existe
    if (!fs.existsSync(SIGNATURES_DIR)) {
      fs.mkdirSync(SIGNATURES_DIR, { recursive: true });
      console.log('✅ Directorio de firmas creado');
    }

    // Configuración de multer para firmas
    const signaturesStorage = multer.diskStorage({
      destination: (req, file, cb) => {
        cb(null, SIGNATURES_DIR);
      },
      filename: (req, file, cb) => {
        const timestamp = Date.now();
        const userId = req.user?.id || 'unknown';
        const ext = path.extname(file.originalname);
        const uniqueName = `signature_${userId}_${timestamp}${ext}`;
        cb(null, uniqueName);
      }
    });

    // Filtro para validar tipos de archivo (solo imágenes)
    const signaturesFileFilter = (req, file, cb) => {
      const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg'];
      const allowedExts = ['.png', '.jpg', '.jpeg'];
      
      const ext = path.extname(file.originalname).toLowerCase();
      
      if (allowedTypes.includes(file.mimetype) && allowedExts.includes(ext)) {
        cb(null, true);
      } else {
        cb(new Error('Solo se permiten archivos PNG o JPG'), false);
      }
    };

    const uploadSignature = multer({
      storage: signaturesStorage,
      fileFilter: signaturesFileFilter,
      limits: {
        fileSize: 2 * 1024 * 1024 // 2MB máximo
      }
    });

    // Servir archivos de firmas estáticamente
    app.use('/signatures', express.static(SIGNATURES_DIR));


    // ============================================
    // GUARDAR Y ENVIAR PDF FINAL
    // ============================================
    
    const finalPdfBytes = await pdfDoc.save();
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(Buffer.from(finalPdfBytes));
    
    console.log('✅ Preview generado correctamente');
    
  } catch (e) {
    console.error('❌ Error generando preview:', e);
    res.status(500).send(`Error: ${e.message}`);
  }
});


// ============================================
// ACTUALIZACIÓN DEL ENDPOINT /generate
// Incluye fichas técnicas en página 2
// ============================================

app.post('/generate', async (req, res) => {
  try {
    const data = req.body;
    const templateName = data.template;
    
    if (!templateName) {
      return res.status(400).send('Template name required');
    }
    
    console.log('📥 Generando descarga para template:', templateName);
    
    // ⭐ OBTENER FIRMA DEL USUARIO
    let userSignature = null;
    if (req.user && req.user.id) {
      try {
        const user = await prisma.user.findUnique({
          where: { id: req.user.id },
          select: { signature: true }
        });
        userSignature = user?.signature || null;
      } catch (e) {
        console.warn('⚠️ No se pudo cargar firma del usuario');
      }
    }
    
    // ⭐ AGREGAR FIRMA AL DATA
    data.userSignature = userSignature;
    
    // ✅ GENERAR PDF BASE CON TU FUNCIÓN EXISTENTE
    const pdfBytes = await generatePdfBuffer(templateName, data, { debug: false });
    
    // ✅ CARGAR EL PDF GENERADO PARA AGREGAR FICHAS
    const pdfDoc = await PDFDocument.load(pdfBytes);
    
    // ============================================
    // ⭐ AGREGAR FICHAS TÉCNICAS EN PÁGINA 2
    // ============================================
    
    if (data.items && data.items.length > 0) {
      const itemsWithFichas = [];
      
      // Buscar productos con fichas
      for (const item of data.items) {
        if (!item.modelo) continue;
        
        try {
          const product = await prisma.product.findFirst({
            where: { 
              model: {
                equals: item.modelo,
                mode: 'insensitive'
              }
            },
            select: { id: true, model: true, ficha: true }
          });
          
          if (product && product.ficha) {
            const fichaPath = path.join(FICHAS_DIR, product.ficha);
            
            if (fs.existsSync(fichaPath)) {
              itemsWithFichas.push({
                modelo: product.model,
                fichaPath: fichaPath,
                fichaFilename: product.ficha
              });
              
              console.log(`✅ Ficha encontrada: ${product.model} -> ${product.ficha}`);
            }
          }
        } catch (e) {
          console.warn(`⚠️ Error buscando ficha para ${item.modelo}:`, e.message);
        }
      }
      
      // Agregar fichas al PDF
      if (itemsWithFichas.length > 0) {
        console.log(`📎 Insertando ${itemsWithFichas.length} fichas en página 2...`);
        
        let insertPosition = 1; // Posición inicial (página 2 en índice base-0)
        
        for (const item of itemsWithFichas) {
          try {
            const fichaExt = path.extname(item.fichaFilename).toLowerCase();
            
            if (fichaExt === '.pdf') {
              // CASO 1: FICHA PDF - Insertar todas sus páginas en posición 2
              const fichaBytes = fs.readFileSync(item.fichaPath);
              const fichaPdf = await PDFDocument.load(fichaBytes);
              const fichaPages = await pdfDoc.copyPages(fichaPdf, fichaPdf.getPageIndices());
              
              // ⭐ INSERTAR en página 2 en lugar de agregar al final
              fichaPages.forEach((page, index) => {
                pdfDoc.insertPage(insertPosition + index, page);
              });
              
              insertPosition += fichaPages.length; // Actualizar posición para próxima ficha
              
              console.log(`  ✅ PDF insertado en página 2: ${item.fichaFilename} (${fichaPages.length} páginas)`);
              
            } else if (['.png', '.jpg', '.jpeg'].includes(fichaExt)) {
              // CASO 2: FICHA IMAGEN - Insertar en página 2
              const imageBytes = fs.readFileSync(item.fichaPath);
              let image;
              
              if (fichaExt === '.png') {
                image = await pdfDoc.embedPng(imageBytes);
              } else {
                image = await pdfDoc.embedJpg(imageBytes);
              }
              
              // ⭐ INSERTAR página en posición 2
              const newPage = pdfDoc.insertPage(insertPosition, [612, 792]);
              const pageWidth = newPage.getWidth();
              const pageHeight = newPage.getHeight();
              
              // Calcular dimensiones para llenar toda la página manteniendo aspect ratio
              const imgAspectRatio = image.width / image.height;
              const pageAspectRatio = pageWidth / pageHeight;
              
              let drawWidth, drawHeight, drawX, drawY;
              
              if (imgAspectRatio > pageAspectRatio) {
                // Imagen más ancha - ajustar al ancho
                drawWidth = pageWidth;
                drawHeight = drawWidth / imgAspectRatio;
                drawX = 0;
                drawY = (pageHeight - drawHeight) / 2;
              } else {
                // Imagen más alta - ajustar a la altura
                drawHeight = pageHeight;
                drawWidth = drawHeight * imgAspectRatio;
                drawX = (pageWidth - drawWidth) / 2;
                drawY = 0;
              }
              
              // Dibujar imagen a pantalla completa
              newPage.drawImage(image, {
                x: drawX,
                y: drawY,
                width: drawWidth,
                height: drawHeight
              });
              
              insertPosition++; // Actualizar posición para próxima ficha
              
              console.log(`  ✅ Imagen insertada en página 2: ${item.fichaFilename}`);
            }
            
          } catch (e) {
            console.error(`  ❌ Error procesando ficha ${item.fichaFilename}:`, e.message);
          }
        }
      }
    }
    
    // ============================================
    // GUARDAR Y ENVIAR PDF FINAL
    // ============================================
    
    const finalPdfBytes = await pdfDoc.save();
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="cotizacion_${data.folio || 'draft'}.pdf"`);
    res.send(Buffer.from(finalPdfBytes));
    
    console.log(`✅ PDF generado correctamente: ${data.folio}`);
    
  } catch (e) {
    console.error('❌ Error generando PDF:', e);
    res.status(500).send(`Error: ${e.message}`);
  }
});

// ============================================
// POSTVENTA - SALDO
// ============================================
app.post('/api/postventa/saldo', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    const { quoteId, folio, monto, notas, fecha } = req.body;

    if (!quoteId || !monto || monto <= 0) {
      return res.status(400).json({ ok: false, error: 'Datos incompletos o monto inválido' });
    }

    // Obtener la cotización original para copiar datos
    const quote = await prisma.quote.findUnique({
      where: { id: parseInt(quoteId) },
      include: { client: true, items: true }
    });

    if (!quote) return res.status(404).json({ ok: false, error: 'Cotización no encontrada' });

    // Generar folio con prefijo SALDO
    const fechaVenta = fecha ? new Date(fecha) : new Date();
    const mes = String(fechaVenta.getMonth() + 1).padStart(2, '0');
    const anio = fechaVenta.getFullYear();
    // ⭐ El saldo hereda el número del folio de la venta original (anticipo)
    const ventaOriginal = await prisma.sale.findFirst({
      where: { quoteId: parseInt(quoteId) }
    });
    const anio2Saldo = String(fechaVenta.getFullYear()).slice(-2);
    const numOriginal = ventaOriginal
      ? ventaOriginal.folio.split('-').pop()
      : String(await generarFolioVenta()).split('-').pop();
    const folioSaldo = `SALDO-${anio2Saldo}-${numOriginal}`;

    // Crear registro de venta tipo saldo (sin orden de producción)
    const saleRecord = await prisma.sale.create({
      data: {
        folio: folioSaldo,
        date: fechaVenta,
        client: quote.clientId ? { connect: { id: quote.clientId } } : undefined,
        createdBy: { connect: { id: userId } },
        items: {
          create: quote.items.map(item => ({
            modelo: item.modelo || '',
            descripcion: item.descripcion || '',
            unitPrice: 0,
            qty: item.qty,
            subtotal: item.subtotal || 0,
            categoryType: item.categoryType || null,
            providerCost: item.providerCost || null,
          }))
        },
        subtotal: parseFloat(monto),
        discount: 0,
        tax: 0,
        total: parseFloat(monto),
        currency: 'MXN',
        exchangeRate: 1,
        netMxn: parseFloat(monto),
        paymentStatus: 'completed',
        deliveryStatus: 'completed',
        tipoCaso: 'saldo',
        notasCaso: notas || null,
      }
    });

    // Marcar la cotización como saldo completado
    await prisma.quote.update({
      where: { id: quote.id },
      data: { status: 'saldo_pagado' }
    });

    await logActivity({
      type: 'saldo_registrado',
      description: `Saldo registrado para cotización ${folio} — Monto: $${parseFloat(monto).toLocaleString('es-MX')}`,
      quoteId: quote.id,
      saleId: saleRecord.id,
      userId,
      metadata: { folio: folioSaldo, monto, folioOriginal: folio }
    });

    console.log(`✅ [POSTVENTA] Saldo registrado: ${folioSaldo}`);
    res.json({ ok: true, folio: folioSaldo, sale: saleRecord });

  } catch (e) {
    console.error('❌ [POSTVENTA/SALDO] Error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// POSTVENTA - REPARACIÓN / MANTENIMIENTO
// ============================================
app.post('/api/postventa/servicio', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    const { quoteId, folio, tipo, monto, notas, fecha } = req.body;

    if (!quoteId || !monto || monto <= 0 || !['reparacion', 'mantenimiento'].includes(tipo)) {
      return res.status(400).json({ ok: false, error: 'Datos incompletos o tipo inválido' });
    }

    const quote = await prisma.quote.findUnique({
      where: { id: parseInt(quoteId) },
      include: { client: true, items: true }
    });

    if (!quote) return res.status(404).json({ ok: false, error: 'Cotización no encontrada' });

    const fechaServicio = fecha ? new Date(fecha) : new Date();
    const prefijo = tipo === 'reparacion' ? 'REP' : 'MANT';
    const anio2Serv = String(fechaServicio.getFullYear()).slice(-2);
    const folioVentaServ = await generarFolioVenta();
    const folioServicio = `${prefijo}-${anio2Serv}-${folioVentaServ.split('-').pop()}`;

    const saleRecord = await prisma.sale.create({
      data: {
        folio: folioServicio,
        date: fechaServicio,
        client: quote.clientId ? { connect: { id: quote.clientId } } : undefined,
        createdBy: { connect: { id: userId } },
        items: {
        create: quote.items.map(item => ({
            modelo: `${tipo === 'reparacion' ? 'Reparación' : 'Mantenimiento'} - ${item.descripcion || item.modelo}`,
            descripcion: item.descripcion || '',
            unitPrice: 0,
            qty: item.qty,
            subtotal: 0,
            categoryType: item.categoryType || null,
            providerCost: item.providerCost || null,
          }))
        },
        subtotal: parseFloat(monto),
        discount: 0,
        tax: 0,
        total: parseFloat(monto),
        currency: 'MXN',
        exchangeRate: 1,
        netMxn: parseFloat(monto),
        paymentStatus: 'completed',
        deliveryStatus: 'completed',
        tipoCaso: tipo,
        reparacionMonto:     tipo === 'reparacion'    ? parseFloat(monto) : null,
        mantenimientoMonto:  tipo === 'mantenimiento' ? parseFloat(monto) : null,
        notasCaso: notas || null,
      }
    });

    await logActivity({
      type: `${tipo}_registrado`,
      description: `${tipo === 'reparacion' ? 'Reparación' : 'Mantenimiento'} registrado para ${folio} — Monto: $${parseFloat(monto).toLocaleString('es-MX')}`,
      quoteId: quote.id,
      saleId: saleRecord.id,
      userId,
      metadata: { folio: folioServicio, monto, tipo, folioOriginal: folio }
    });

    console.log(`✅ [POSTVENTA] ${tipo} registrado: ${folioServicio}`);
    res.json({ ok: true, folio: folioServicio, sale: saleRecord });

  } catch (e) {
    console.error(`❌ [POSTVENTA/${tipo?.toUpperCase()}] Error:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ⭐ Palabras clave para detección automática de comercialización
const COMERCIALIZACION_KEYWORDS = [
  { keywords: ['ups', 'no break', 'nobreak', 'no-break'],      tipo: 'ups' },
  { keywords: ['regulador electrónico', 'regulador electronico', 'electronico'], tipo: 'regulador_electronico' },
  { keywords: ['equipo ec', 'ec '],                             tipo: 'equipo_ec' },
  { keywords: ['planta'],                                       tipo: 'planta' },
  { keywords: ['transformador'],                                tipo: 'transformador' },
  { keywords: ['instalacion', 'instalación'],                   tipo: 'instalacion' },
  { keywords: ['supresor'],                                     tipo: 'supresor' },
  { keywords: ['multimetro', 'multímetro'],                     tipo: 'multimetro' },
  { keywords: ['extension de garantia', 'extensión de garantía', 'garantia extendida'], tipo: 'garantia' },
];

app.get('/api/comercializacion/detectar', requireAuth, (req, res) => {
  const texto = (req.query.texto || '').toLowerCase().trim();
  if (!texto) return res.json({ esComercializacion: false, tipo: null });

  for (const entry of COMERCIALIZACION_KEYWORDS) {
    if (entry.keywords.some(kw => texto.includes(kw))) {
      return res.json({ esComercializacion: true, tipo: entry.tipo });
    }
  }
  res.json({ esComercializacion: false, tipo: null });
});

// ⭐ Retorna la lista completa de keywords (para detección en frontend sin fetch)
app.get('/api/comercializacion/keywords', requireAuth, (req, res) => {
  res.json({ keywords: COMERCIALIZACION_KEYWORDS });
});

// ============================================
// CONFIGURACIÓN DEL SISTEMA
// ============================================

// Obtener configuración
app.get('/api/config', requireAuth, async (req, res) => {
  try {
    const configs = await prisma.config.findMany();
    const result = {};
    configs.forEach(c => result[c.clave] = c.valor);
    res.json({ ok: true, config: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Guardar configuración
app.post('/api/config', requireAuth, async (req, res) => {
  try {
    const { clave, valor } = req.body;
    if (!clave || valor === undefined) {
      return res.status(400).json({ ok: false, error: 'Clave y valor requeridos' });
    }
    await prisma.config.upsert({
      where: { clave },
      update: { valor: String(valor) },
      create: { clave, valor: String(valor) }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// SERVER START
// ============================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Server corriendo en http://localhost:${PORT}`);

  // ⭐ Crear usuario admin por defecto si no hay usuarios
(async () => {
  try {
    const count = await prisma.user.count();
    if (count === 0) {
      const bcrypt = require('bcryptjs');
      const hash = await bcrypt.hash('Admin123', 10);
      await prisma.user.create({
        data: {
          name: 'Administrador',
          email: 'admin@revolt.com',
          password: hash,
          role: 'admin',
          active: true
        }
      });
      console.log('👤 Usuario admin creado por defecto: admin@revolt.com / Admin123');
    }
  } catch(e) {
    console.log('⚠️ No se pudo crear usuario por defecto:', e.message);
  }
})();

  console.log('📊 Conectado a PostgreSQL con Prisma');
  
  try {
    const clientCount = await prisma.client.count();
    const productCount = await prisma.product.count();
    
    if (clientCount === 0) {
      await prisma.client.createMany({
        data: [
          { name: 'Juan Pérez', company: 'Acme Corp', phone: '555-0001', email: 'juan@acme.com', estado: 'CDMX' },
          { name: 'María García', company: 'Tech Solutions', phone: '555-0002', email: 'maria@tech.com', estado: 'Jalisco' },
          { name: 'Carlos López', company: 'Industrias XYZ', phone: '555-0003', email: 'carlos@xyz.com', estado: 'Nuevo León' }
        ]
      });
      console.log('✅ Clientes de demo creados');
    }
    
    if (productCount === 0) {
      await prisma.product.createMany({
        data: [
          { model: 'RM-042-220', description: 'Regulador 4 kVA', price: 987.36, currency: 'USD' },
          { model: 'RM-100-240', description: 'Regulador 10 kVA', price: 1850.00, currency: 'USD' },
          { model: 'UPS-500', description: 'UPS 500VA', price: 450.00, currency: 'USD' },
          { model: 'UPS-1000', description: 'UPS 1000VA', price: 780.00, currency: 'USD' },
          { model: 'ESTABILIZADOR-5KVA', description: 'Estabilizador 5 kVA', price: 1200.00, currency: 'USD' }
        ]
      });
      console.log('✅ Productos de demo creados');
    }
    
    console.log(`📦 Clientes: ${clientCount === 0 ? 3 : clientCount}`);
    console.log(`📦 Productos: ${productCount === 0 ? 5 : productCount}`);

    // ⭐ CREAR USUARIO ADMIN POR DEFECTO
    const userCount = await prisma.user.count();
    
    if (userCount === 0) {
      const adminPassword = await hashPassword('admin123');
      
      await prisma.user.create({
        data: {
          name: 'Administrador',
          email: 'admin@revolt.com',
          password: adminPassword,
          role: 'admin',
          active: true
        }
      });
      
      console.log('✅ Usuario admin creado:');
      console.log('   Email: admin@revolt.com');
      console.log('   Password: admin123');
      console.log('   ⚠️ CAMBIA EL PASSWORD DESPUÉS DEL PRIMER LOGIN');
    }
    
    console.log(`👤 Usuarios: ${userCount === 0 ? 1 : userCount}`);

  } catch (e) {
    console.error('⚠️ Error en seed inicial:', e.message);
  }
});

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

// ============================================
// DEBUG: Endpoint temporal para verificar calibración
// ============================================
app.get('/api/debug/calibration/:template', (req, res) => {
  try {
    const templateName = safeName(req.params.template);
    const calibPath = path.join(CALIB_DIR, templateName + '.json');
    
    console.log('🔍 DEBUG CALIBRACIÓN:');
    console.log('  Template:', templateName);
    console.log('  Path:', calibPath);
    console.log('  Existe:', fs.existsSync(calibPath));
    
    if (!fs.existsSync(calibPath)) {
      return res.json({
        ok: false,
        error: 'Calibración no encontrada',
        path: calibPath,
        suggestion: 'Necesitas calibrar esta plantilla primero'
      });
    }
    
    const calibContent = fs.readFileSync(calibPath, 'utf-8');
    const calib = JSON.parse(calibContent);
    
    // Analizar estructura
    const analysis = {
      ok: true,
      template: templateName,
      path: calibPath,
      format: calib.pages ? 'multi-página ✅' : 'legacy (antiguo) ⚠️',
      totalPages: calib.pages ? Object.keys(calib.pages).length : 0,
      globalOffsetY: calib.globalOffsetY || 0,
      pages: {}
    };
    
    // Analizar cada página
    if (calib.pages) {
      Object.keys(calib.pages).forEach(pageNum => {
        const pageData = calib.pages[pageNum];
        const fields = Object.keys(pageData.fields || {});
        
        // Detectar campos de condiciones comerciales
        const condicionesFields = fields.filter(f => 
          f.includes('tiempo') || 
          f.includes('entrega') || 
          f.includes('forma') || 
          f.includes('pago') ||
          f.includes('Entrega') ||
          f.includes('Pago')
        );
        
        analysis.pages[`Página ${pageNum}`] = {
          totalCampos: fields.length,
          camposCondiciones: condicionesFields.length,
          listaCondiciones: condicionesFields,
          tieneTabla: !!pageData.table,
          ejemploCampos: fields.slice(0, 5) // Primeros 5 campos
        };
      });
    } else if (calib.fields) {
      // Formato antiguo
      analysis.warning = 'Esta calibración usa formato antiguo (single-page). Necesitas recalibrar con el formato multi-página.';
      analysis.totalCamposLegacy = Object.keys(calib.fields).length;
    }
    
    res.json(analysis);
    
  } catch (e) {
    console.error('❌ Error en debug:', e);
    res.status(500).json({
      ok: false,
      error: e.message,
      stack: e.stack
    });
  }
});

// ============================================
// DEBUG: Verificar qué páginas tiene un PDF
// ============================================
app.get('/api/debug/pdf-pages/:template', async (req, res) => {
  try {
    const templateName = safeName(req.params.template);
    const templatePath = path.join(TEMPLATES_DIR, templateName);
    
    if (!fs.existsSync(templatePath)) {
      return res.json({
        ok: false,
        error: 'Plantilla no encontrada',
        path: templatePath
      });
    }
    
    const pdfBytes = fs.readFileSync(templatePath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pages = pdfDoc.getPages();
    
    const pagesInfo = pages.map((page, index) => {
      const { width, height } = page.getSize();
      return {
        numero: index + 1,
        ancho: Math.round(width),
        alto: Math.round(height),
        formato: width === 612 && height === 792 ? 'Carta (Letter)' : 'Otro'
      };
    });
    
    res.json({
      ok: true,
      template: templateName,
      totalPaginas: pages.length,
      paginas: pagesInfo
    });
    
  } catch (e) {
    console.error('❌ Error:', e);
    res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});

// DEBUG: Verificar calibración
app.get('/api/debug/calibration/:template', (req, res) => {
  try {
    const templateName = req.params.template;
    const safe = safeName(templateName);
    
    console.log('🔍 DEBUG CALIBRACIÓN:');
    console.log('  Template solicitado:', templateName);
    console.log('  Template safe:', safe);
    
    const templatePath = path.join(TEMPLATES_DIR, safe);
    const calibPath = path.join(CALIB_DIR, safe + '.json');
    
    console.log('  Template path:', templatePath);
    console.log('  Calibración path:', calibPath);
    console.log('  Template existe:', fs.existsSync(templatePath));
    console.log('  Calibración existe:', fs.existsSync(calibPath));
    
    if (!fs.existsSync(calibPath)) {
      return res.json({
        ok: false,
        error: 'Calibración no encontrada',
        paths: {
          template: templatePath,
          calibration: calibPath,
          templateExists: fs.existsSync(templatePath),
          calibrationExists: false
        }
      });
    }
    
    const calib = loadCalibrationForTemplate(safe);
    
    res.json({
      ok: true,
      template: safe,
      calibration: calib,
      paths: {
        template: templatePath,
        calibration: calibPath,
        templateExists: fs.existsSync(templatePath),
        calibrationExists: fs.existsSync(calibPath)
      },
      fieldsCount: Object.keys(calib.fields || {}).length
    });
    
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message,
      stack: e.stack
    });
  }
});