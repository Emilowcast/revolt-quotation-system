// auth-guard.js - Script de protección de páginas
// Incluir este script en todas las páginas que requieren autenticación

(function() {
  'use strict';
  
  // ============================================
  // FUNCIÓN PRINCIPAL DE AUTENTICACIÓN
  // ============================================
  
  async function checkAuthentication() {
    console.log('🔒 Verificando autenticación...');
    
    // Lista de páginas públicas (no requieren autenticación)
    const publicPages = ['/login.html'];
    const currentPage = window.location.pathname;
    
    // Si estamos en una página pública, no verificar
    if (publicPages.includes(currentPage)) {
      console.log('📄 Página pública, no se requiere autenticación');
      return;
    }
    
    try {
      // ⭐ NUEVO: Intentar con cookies PRIMERO, luego con token
      let response;
      let headers = {
        'Content-Type': 'application/json'
      };
      
      // Intentar con token de localStorage si existe
      const token = localStorage.getItem('token');
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
        console.log('🔑 Usando token de localStorage');
      }
      
      response = await fetch('/api/auth/me', {
        method: 'GET',
        headers: headers,
        credentials: 'include' // También intentar con cookies
      });
      
      if (!response.ok) {
        console.warn('⚠️ No autenticado, redirigiendo a login...');
        
        // Limpiar token si existe
        if (token) {
          localStorage.removeItem('token');
        }
        
        window.location.href = '/login.html';
        return;
      }
      
      const data = await response.json();
      
      if (!data.ok || !data.user) {
        console.warn('⚠️ Respuesta inválida, redirigiendo a login...');
        if (token) {
          localStorage.removeItem('token');
        }
        window.location.href = '/login.html';
        return;
      }
      
      const user = data.user;
      
      console.log('✅ Usuario autenticado:', user.email, `(${user.role})`);
      
      // Guardar usuario en variable global
      window.currentUser = user;
      
      // Actualizar navbar con información del usuario
      updateNavbarUser(user);
      
      // Verificar permisos de página
      checkPagePermissions(user);
      
      // Disparar evento personalizado para que otras páginas sepan que ya está autenticado
      window.dispatchEvent(new CustomEvent('userAuthenticated', { detail: user }));
      
    } catch (e) {
      console.error('❌ Error verificando autenticación:', e);
      
      // Limpiar token
      const token = localStorage.getItem('token');
      if (token) {
        localStorage.removeItem('token');
      }
      
      window.location.href = '/login.html';
    }
  }
  
  // ============================================
  // EJECUTAR CUANDO EL DOM ESTÉ LISTO
  // ============================================
  
  if (document.readyState === 'loading') {
    // DOM aún no está listo
    document.addEventListener('DOMContentLoaded', checkAuthentication);
  } else {
    // DOM ya está listo
    checkAuthentication();
  }
})();

// ============================================
// FUNCIONES GLOBALES (fuera del IIFE)
// ============================================

/**
 * Actualizar navbar con información del usuario
 */
function updateNavbarUser(user) {
  // Buscar elemento de usuario en navbar
  const userNameElement = document.getElementById('currentUserName');
  const userRoleElement = document.getElementById('currentUserRole');
  
  if (userNameElement) {
    userNameElement.textContent = user.name;
  }
  
  if (userRoleElement) {
    const roleText = user.role === 'admin' ? '👑 Admin' : '👤 Vendedor';
    userRoleElement.textContent = roleText;
  }
  
  // También actualizar userEmail si existe (para trash.html)
  const userEmailElement = document.getElementById('userEmail');
  if (userEmailElement) {
    userEmailElement.textContent = user.email;
  }
  
  // Si existe menú de usuarios, solo mostrarlo a admins
  const usersMenuItem = document.querySelector('a[href="/users.html"]');
  if (usersMenuItem) {
    const parentLi = usersMenuItem.closest('li');
    if (parentLi) {
      parentLi.style.display = user.role === 'admin' ? 'block' : 'none';
    }
  }
}

/**
 * Verificar permisos de página según rol
 */
function checkPagePermissions(user) {
  const adminOnlyPages = ['/users.html', '/sales.html'];
  const currentPage = window.location.pathname;
  
  // Verificar si la página es solo para admins
if (adminOnlyPages.includes(currentPage) && user.role !== 'admin') {
    // El modal de cada página maneja la restricción
  }
}

/**
 * Logout function (global)
 */
window.logout = async function() {
  if (!confirm('¿Cerrar sesión?')) return;
  
  try {
    // Intentar logout con ambos métodos
    const token = localStorage.getItem('token');
    const headers = {
      'Content-Type': 'application/json'
    };
    
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    
    const response = await fetch('/api/auth/logout', {
      method: 'POST',
      headers: headers,
      credentials: 'include'
    });
    
    console.log('✅ Logout exitoso');
    
    // Limpiar token
    localStorage.removeItem('token');
    
    window.location.href = '/login.html';
    
  } catch (e) {
    console.error('❌ Error en logout:', e);
    
    // Limpiar token de todas formas
    localStorage.removeItem('token');
    
    // Redirigir de todas formas
    window.location.href = '/login.html';
  }
};