#!/usr/bin/env python3
"""
Script: generate-production-order.py
Descripción: Genera un archivo Excel de Orden de Producción a partir de una plantilla
             y datos de una cotización
VERSIÓN CORREGIDA: Maneja correctamente celdas combinadas
"""

import sys
import json
import openpyxl
from openpyxl import load_workbook
from openpyxl.styles import Font, Alignment
from datetime import datetime
import os

def fill_production_order(template_path, output_path, data_json):
    """
    Llena la plantilla de Orden de Producción con los datos de la cotización
    
    Args:
        template_path: Ruta del archivo template
        output_path: Ruta donde guardar el archivo generado
        data_json: JSON string con los datos
    """
    
    try:
        # Parsear datos
        data = json.loads(data_json)
        
        # Cargar template
        print(f"📂 Cargando template: {template_path}", file=sys.stderr)
        wb = load_workbook(template_path)
        ws = wb.active  # Primera hoja
        
        print(f"📄 Hoja activa: {ws.title}", file=sys.stderr)
        
        # ===========================================
        # LLENAR ENCABEZADO
        # ===========================================
        
        # Fecha (celda O2)
        ws['O2'] = data.get('fecha', datetime.now().strftime('%d/%m/%Y'))
        ws['O2'].font = Font(name='Arial', size=10, bold=True)
        ws['O2'].alignment = Alignment(horizontal='center', vertical='center')
        
        # Folio (celda P3)
        ws['P3'] = str(data.get('folio', ''))
        ws['P3'].font = Font(name='Arial', size=11, bold=True)
        ws['P3'].alignment = Alignment(horizontal='center', vertical='center')
        
        # Cliente (celda M5 - parte del rango combinado M5:P5)
        ws['M5'] = data.get('cliente', '')
        ws['M5'].font = Font(name='Arial', size=10)
        ws['M5'].alignment = Alignment(horizontal='left', vertical='center')
        
        # ===========================================
        # LLENAR INFORMACIÓN DEL EQUIPO
        # ===========================================
        
        items = data.get('items', [])
        
        if items:
            # Usar el primer item para llenar los campos principales
            item = items[0]
            
            # PRODUCTO (celda A8 - parte del rango combinado A8:B8)
            ws['A8'] = item.get('producto', '')
            ws['A8'].font = Font(name='Arial', size=10)
            ws['A8'].alignment = Alignment(horizontal='left', vertical='center')
            
            # CAPACIDAD (celda C8 - parte del rango combinado C8:D7)
            ws['C8'] = item.get('capacidad', '')
            ws['C8'].font = Font(name='Arial', size=10)
            ws['C8'].alignment = Alignment(horizontal='center', vertical='center')
            
            # VOLTAJE - Entrada (celda E8 - parte del rango combinado E7:G7)
            ws['E8'] = item.get('voltajeEntrada', '')
            ws['E8'].font = Font(name='Arial', size=10)
            ws['E8'].alignment = Alignment(horizontal='center', vertical='center')
            
            # VOLTAJE - Salida (celda H8 - rango combinado I7:K7)
            ws['H8'] = item.get('voltajeSalida', '')
            ws['H8'].font = Font(name='Arial', size=10)
            ws['H8'].alignment = Alignment(horizontal='center', vertical='center')
            
            # AMPERAJE - Entrada (celda I8)
            ws['I8'] = item.get('amperajeEntrada', '')
            ws['I8'].font = Font(name='Arial', size=10)
            ws['I8'].alignment = Alignment(horizontal='center', vertical='center')
            
            # AMPERAJE - Salida (celda L8)
            ws['L8'] = item.get('amperajeSalida', '')
            ws['L8'].font = Font(name='Arial', size=10)
            ws['L8'].alignment = Alignment(horizontal='center', vertical='center')
            
            # MODELO (celda M8 - parte del rango combinado M6:M7)
            ws['M8'] = item.get('modelo', '')
            ws['M8'].font = Font(name='Arial', size=10)
            ws['M8'].alignment = Alignment(horizontal='center', vertical='center')
            
            # CANTIDAD (celda N8 - parte del rango combinado N6:P7)
            # ⭐ CORRECCIÓN: Esta es la celda superior izquierda del rango N6:P7
            cantidad_total = sum(i.get('cantidad', 0) for i in items)
            ws['N6'] = cantidad_total
            ws['N6'].font = Font(name='Arial', size=11, bold=True)
            ws['N6'].alignment = Alignment(horizontal='center', vertical='center')
            
            # TIPO - Marcar con X el tipo correspondiente
            tipo = item.get('tipo', '1F').upper()
            
            # Limpiar marcas anteriores
            ws['A11'] = ''
            ws['C11'] = ''
            ws['E11'] = ''
            ws['H11'] = ''
            
            # Marcar el tipo correspondiente
            if tipo == '1F':
                ws['A11'] = 'X'
                ws['A11'].font = Font(name='Arial', size=14, bold=True)
                ws['A11'].alignment = Alignment(horizontal='center', vertical='center')
            elif tipo == '2F':
                ws['C11'] = 'X'
                ws['C11'].font = Font(name='Arial', size=14, bold=True)
                ws['C11'].alignment = Alignment(horizontal='center', vertical='center')
            elif tipo == '2FN':
                ws['E11'] = 'X'
                ws['E11'].font = Font(name='Arial', size=14, bold=True)
                ws['E11'].alignment = Alignment(horizontal='center', vertical='center')
            elif tipo == '3F':
                ws['H11'] = 'X'
                ws['H11'].font = Font(name='Arial', size=14, bold=True)
                ws['H11'].alignment = Alignment(horizontal='center', vertical='center')
            
            # NÚMERO DE SERIE (celda K10 - superior izquierda del rango combinado K10:P10)
            # ⭐ CORRECCIÓN: K10 es la celda principal del rango K10:P10
            ws['K10'] = item.get('numeroSerie', '')
            ws['K10'].font = Font(name='Arial', size=10)
            ws['K10'].alignment = Alignment(horizontal='center', vertical='center')
        
        # ===========================================
        # FECHAS Y ADICIONALES
        # ===========================================
        
        # FECHA INICIO DE PRODUCCIÓN (celda A12 - superior izquierda del rango A12:F13)
        fecha_inicio = data.get('fechaInicio', '')
        if fecha_inicio:
            ws['A12'] = fecha_inicio
            ws['A12'].font = Font(name='Arial', size=10)
            ws['A12'].alignment = Alignment(horizontal='center', vertical='center')
        
        # FECHA SALIDA DE PRODUCCIÓN (celda A14 - superior izquierda del rango A14:F15)
        fecha_salida = data.get('fechaSalida', '')
        if fecha_salida:
            ws['A14'] = fecha_salida
            ws['A14'].font = Font(name='Arial', size=10)
            ws['A14'].alignment = Alignment(horizontal='center', vertical='center')
        
        # ADICIONALES (celda K12 - superior izquierda del rango K12:P12)
        adicionales = data.get('adicionales', '')
        if adicionales:
            ws['K12'] = adicionales
            ws['K12'].font = Font(name='Arial', size=9)
            ws['K12'].alignment = Alignment(horizontal='left', vertical='top', wrap_text=True)
        
        # OBSERVACIONES (celda A16 - superior izquierda del rango A16:J16)
        observaciones = data.get('observaciones', '')
        if observaciones:
            ws['A16'] = observaciones
            ws['A16'].font = Font(name='Arial', size=9)
            ws['A16'].alignment = Alignment(horizontal='left', vertical='top', wrap_text=True)
        
        # ===========================================
        # GUARDAR ARCHIVO
        # ===========================================
        
        print(f"💾 Guardando archivo en: {output_path}", file=sys.stderr)
        
        # Crear directorio si no existe
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        
        # Guardar
        wb.save(output_path)
        wb.close()
        
        print(f"✅ Orden de Producción generada exitosamente", file=sys.stderr)
        return True
        
    except Exception as e:
        print(f"❌ Error: {str(e)}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        return False

def main():
    """Función principal"""
    
    if len(sys.argv) != 4:
        print("❌ Uso: python3 generate-production-order.py <template_path> <output_path> <data_json>", file=sys.stderr)
        sys.exit(1)
    
    template_path = sys.argv[1]
    output_path = sys.argv[2]
    data_json = sys.argv[3]
    
    # Verificar que el template existe
    if not os.path.exists(template_path):
        print(f"❌ Template no encontrado: {template_path}", file=sys.stderr)
        sys.exit(1)
    
    # Generar orden de producción
    success = fill_production_order(template_path, output_path, data_json)
    
    if success:
        sys.exit(0)
    else:
        sys.exit(1)

if __name__ == '__main__':
    main()