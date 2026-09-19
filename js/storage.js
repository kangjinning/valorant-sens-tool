/* =============================================================================
 * storage.js — 浏览器本地存储封装（localStorage）
 * -----------------------------------------------------------------------------
 * 目标：
 *   1. 保存 DPI / 灵敏度 / 目标 DPI 等配置，刷新页面不丢失。
 *   2. 所有访问都包 try/catch —— 部分浏览器在「无痕模式」或禁用 Cookie 时
 *      访问 localStorage 会直接抛异常；文件协议（file://）下个别浏览器也会受限。
 *      任何失败都静默降级为「本次会话内可用」，绝不因为存储问题导致页面报错。
 *   3. 存入的数据带 schema 版本号，未来结构调整时可安全忽略旧数据。
 * ============================================================================= */

/* eslint-disable no-var */
var VStorage = (function () {
  'use strict';

  /** 存储键名（带版本号，便于未来迁移） */
  var KEY = 'valorant-sens-tool:v1';

  /** 当前数据结构的版本 */
  var SCHEMA_VERSION = 1;

  /** 内存兜底：localStorage 不可用时（无痕/被禁用）仍然让页面本次可用 */
  var memoryFallback = null;

  /** 探测 localStorage 是否真正可写（有些环境存在对象但写入抛异常） */
  function isAvailable() {
    try {
      var probe = '__vst_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      return true;
    } catch (e) {
      return false;
    }
  }

  var available = typeof window !== 'undefined' && 'localStorage' in window && isAvailable();

  /**
   * 读取已保存的配置。
   * @returns {{dpi:(string|null), sens:(string|null), targetDpi:(string|null), savedAt:(number|null)}|null}
   */
  function load() {
    var raw = null;
    try {
      raw = available ? window.localStorage.getItem(KEY) : memoryFallback;
    } catch (e) {
      raw = null;
    }
    if (!raw) return null;

    try {
      var data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return null;
      // 版本不一致时直接视为无效（保持逻辑简单，不做自动迁移）
      if (data.v !== SCHEMA_VERSION) return null;
      return {
        dpi: typeof data.dpi === 'string' ? data.dpi : null,
        sens: typeof data.sens === 'string' ? data.sens : null,
        targetDpi: typeof data.targetDpi === 'string' ? data.targetDpi : null,
        savedAt: typeof data.savedAt === 'number' ? data.savedAt : null
      };
    } catch (e) {
      return null;   // 数据损坏，忽略即可
    }
  }

  /**
   * 保存配置（只保存字符串，保持与输入框内容一致，避免精度丢失）。
   * @param {{dpi?:string, sens?:string, targetDpi?:string}} config
   * @returns {boolean} 是否真正写入持久化存储
   */
  function save(config) {
    var payload = JSON.stringify({
      v: SCHEMA_VERSION,
      dpi: config && config.dpi != null ? String(config.dpi) : '',
      sens: config && config.sens != null ? String(config.sens) : '',
      targetDpi: config && config.targetDpi != null ? String(config.targetDpi) : '',
      savedAt: Date.now()
    });

    memoryFallback = payload;
    if (!available) return false;

    try {
      window.localStorage.setItem(KEY, payload);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 清空配置。
   * @returns {boolean} 是否真正从持久化存储中删除
   */
  function clear() {
    memoryFallback = null;
    if (!available) return false;
    try {
      window.localStorage.removeItem(KEY);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 是否存在已保存的配置 */
  function has() {
    return load() !== null;
  }

  return {
    KEY: KEY,
    SCHEMA_VERSION: SCHEMA_VERSION,
    available: available,
    load: load,
    save: save,
    clear: clear,
    has: has
  };
})();
