import { beforeEach, describe, expect, it } from 'vitest';
import { request, resetBusinessData } from './helpers';

beforeEach(async()=>{await resetBusinessData();});

describe('health, security headers and routing',()=>{
  it('reports every mandatory binding and safe Meta configuration state',async()=>{
    const response=await request('/health');expect(response.status).toBe(200);const body=await response.json<any>();expect(body).toEqual({ok:true,components:{worker:true,d1:true,r2Binding:true,queuesBinding:true,workersAiBinding:true,vectorizeBinding:true,metaConfiguration:'not_configured'}});
  });

  it('adds browser security headers to API errors and does not expose stack traces',async()=>{
    const response=await request('/api/dashboard');expect(response.status).toBe(401);expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');expect(response.headers.get('X-Frame-Options')).toBe('DENY');expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");const text=await response.text();expect(text).not.toContain('node_modules');expect(text).not.toContain(' at ');
  });

  it('sends unknown non-API paths to assets and protects unknown API paths before revealing route details',async()=>{
    const page=await request('/unknown-page');expect(page.status).toBe(404);expect(page.headers.get('Content-Type')).toBeNull();
    const api=await request('/api/does-not-exist');expect(api.status).toBe(401);expect(api.headers.get('Content-Type')).toContain('application/json');expect(await api.json<any>()).toMatchObject({ok:false,error:{code:'AUTH_REQUIRED'}});
  });
});
