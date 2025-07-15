#!/usr/bin/env node

// Simple deployment verification script
import fetch from 'node-fetch';

const BASE_URL = process.env.SERVICE_URL || 'http://localhost:8080';

async function testEndpoint(url, method = 'GET', body = null) {
  try {
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body && { body: JSON.stringify(body) })
    };
    
    const response = await fetch(url, options);
    const data = await response.json();
    
    return {
      success: response.ok,
      status: response.status,
      data
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

async function runTests() {
  console.log('🚀 Testing email validator deployment...\n');
  
  // Test 1: Health check
  console.log('1. Testing health check...');
  const healthTest = await testEndpoint(`${BASE_URL}/`);
  console.log(healthTest.success ? '✅ Health check passed' : '❌ Health check failed');
  
  // Test 2: Network connectivity
  console.log('\n2. Testing network connectivity...');
  const networkTest = await testEndpoint(`${BASE_URL}/test-network`);
  if (networkTest.success) {
    const { tests, dnsTest } = networkTest.data;
    const smtpPassing = tests.filter(t => t.success).length;
    console.log(`✅ Network test completed: ${smtpPassing}/${tests.length} SMTP connections successful`);
    console.log(`✅ DNS test: ${dnsTest.success ? 'passed' : 'failed'}`);
  } else {
    console.log('❌ Network test failed');
  }
  
  // Test 3: Email validation
  console.log('\n3. Testing email validation...');
  const emailTest = await testEndpoint(`${BASE_URL}/validateEmail`, 'POST', {
    email: 'test@gmail.com'
  });
  console.log(emailTest.success ? '✅ Email validation endpoint working' : '❌ Email validation failed');
  
  // Test 4: Batch validation
  console.log('\n4. Testing batch validation...');
  const batchTest = await testEndpoint(`${BASE_URL}/validateEmailBatch`, 'POST', {
    emails: ['test@gmail.com', 'invalid@nonexistent.xyz']
  });
  console.log(batchTest.success ? '✅ Batch validation endpoint working' : '❌ Batch validation failed');
  
  console.log('\n🎉 Deployment verification completed!');
}

runTests().catch(console.error);