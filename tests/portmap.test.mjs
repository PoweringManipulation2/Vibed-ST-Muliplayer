/**
 * Port-mapping tests.
 *
 * There is no router in CI, so this does not test that a mapping succeeds. What
 * it does test is everything that would silently produce a wrong or unsafe
 * request: the NAT-PMP packet layout, gateway derivation, the SOAP envelope,
 * device-description parsing, and the guard that stops a hostile device on the
 * LAN from steering us at an arbitrary URL.
 *
 * Run with:  node tests/portmap.test.mjs
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const { PortMapper, isPrivateIPv4, __testing } = await import(path.join(root, 'server/lib/portmap.js'));
const { candidateGateways, findWanService, soapEnvelope, escapeXml } = __testing;

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  \u2713 ${name}`);
        passed += 1;
    } catch (error) {
        console.error(`  \u2717 ${name}\n      ${error.message}`);
        failed += 1;
    }
}

console.log('\nAddress classification');

await test('carrier-grade NAT space counts as private', () => {
    // This is the check that distinguishes "the router opened a port for you"
    // from "the router opened a port that leads nowhere".
    for (const ip of ['100.64.0.1', '100.100.1.1', '100.127.255.255']) {
        assert.equal(isPrivateIPv4(ip), true, `${ip} should be private`);
    }
    assert.equal(isPrivateIPv4('100.63.255.255'), false);
    assert.equal(isPrivateIPv4('100.128.0.0'), false);
});

await test('the usual private ranges are covered', () => {
    for (const ip of ['10.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.255', '127.0.0.1', '169.254.1.1', '0.0.0.0']) {
        assert.equal(isPrivateIPv4(ip), true, `${ip} should be private`);
    }
    for (const ip of ['8.8.8.8', '203.0.113.1', '172.32.0.1', '172.15.255.255', '192.169.0.1']) {
        assert.equal(isPrivateIPv4(ip), false, `${ip} should be public`);
    }
});

await test('malformed input is treated as private, never as public', () => {
    // Failing closed matters: mistaking junk for a public address would produce
    // a connection code pointing at nothing.
    for (const value of ['', null, undefined, 'nonsense', '1.2.3', '1.2.3.4.5', '999.1.1.1', '-1.0.0.0']) {
        assert.equal(isPrivateIPv4(value), true, `${JSON.stringify(value)} should fail closed`);
    }
});

console.log('\nGateway derivation');

await test('produces plausible gateway candidates from local interfaces', () => {
    const gateways = candidateGateways();
    assert.ok(Array.isArray(gateways));
    for (const gateway of gateways) {
        assert.match(gateway, /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, `${gateway} is not an IPv4 address`);
        const octets = gateway.split('.').map(Number);
        assert.ok(octets.every(o => o >= 0 && o <= 255), `${gateway} has an out-of-range octet`);
    }
});

await test('candidates are unique', () => {
    const gateways = candidateGateways();
    assert.equal(new Set(gateways).size, gateways.length);
});

console.log('\nSOAP request construction');

await test('builds a well-formed AddPortMapping envelope', () => {
    const xml = soapEnvelope('urn:schemas-upnp-org:service:WANIPConnection:1', 'AddPortMapping', {
        NewRemoteHost: '',
        NewExternalPort: 8899,
        NewProtocol: 'TCP',
        NewInternalPort: 8899,
        NewInternalClient: '192.168.1.42',
        NewEnabled: 1,
        NewPortMappingDescription: 'SillyTavern Multiplayer',
        NewLeaseDuration: 3600,
    });

    assert.ok(xml.startsWith('<?xml version="1.0"?>'));
    assert.ok(xml.includes('<u:AddPortMapping xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">'));
    assert.ok(xml.includes('<NewExternalPort>8899</NewExternalPort>'));
    assert.ok(xml.includes('<NewInternalClient>192.168.1.42</NewInternalClient>'));
    assert.ok(xml.includes('<NewProtocol>TCP</NewProtocol>'));
    assert.ok(xml.trimEnd().endsWith('</s:Envelope>'));

    // Tags must balance, or the router rejects the whole call.
    const opens = (xml.match(/<[^/?][^>]*>/g) ?? []).length;
    const closes = (xml.match(/<\/[^>]+>/g) ?? []).length;
    assert.equal(opens, closes, 'unbalanced tags in the envelope');
});

await test('argument values are XML-escaped', () => {
    const xml = soapEnvelope('svc', 'Action', { NewPortMappingDescription: 'a & b <c> "d"' });
    assert.ok(xml.includes('a &amp; b &lt;c&gt; &quot;d&quot;'));
    assert.ok(!xml.includes('<c>'), 'a raw angle bracket survived into the envelope');
});

await test('escapeXml covers every character that would break a document', () => {
    assert.equal(escapeXml('&<>"\''), '&amp;&lt;&gt;&quot;&apos;');
    assert.equal(escapeXml(null), '');
    assert.equal(escapeXml(42), '42');
});

console.log('\nDevice description parsing');

const DESCRIPTION_XML = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
 <device>
  <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
  <serviceList>
   <service>
    <serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType>
    <controlURL>/ctl/L3F</controlURL>
   </service>
  </serviceList>
  <deviceList><device><deviceList><device>
   <serviceList>
    <service>
     <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
     <SCPDURL>/WANIPCn.xml</SCPDURL>
     <controlURL>/ctl/IPConn</controlURL>
    </service>
   </serviceList>
  </device></deviceList></device></deviceList>
 </device>
</root>`;

await test('finds the WAN connection service and resolves its control URL', () => {
    const service = findWanService(DESCRIPTION_XML, 'http://192.168.1.1:5000/rootDesc.xml');
    assert.ok(service, 'no WAN service found');
    assert.equal(service.serviceType, 'urn:schemas-upnp-org:service:WANIPConnection:1');
    assert.equal(service.controlUrl, 'http://192.168.1.1:5000/ctl/IPConn');
});

await test('handles an absolute control URL', () => {
    const xml = DESCRIPTION_XML.replace('/ctl/IPConn', 'http://192.168.1.1:5000/upnp/control/WANIPConn1');
    const service = findWanService(xml, 'http://192.168.1.1:5000/rootDesc.xml');
    assert.equal(service.controlUrl, 'http://192.168.1.1:5000/upnp/control/WANIPConn1');
});

await test('prefers WANIPConnection:2 when the router offers it', () => {
    const xml = DESCRIPTION_XML.replace(
        'urn:schemas-upnp-org:service:WANIPConnection:1',
        'urn:schemas-upnp-org:service:WANIPConnection:2');
    const service = findWanService(xml, 'http://192.168.1.1:5000/rootDesc.xml');
    assert.equal(service.serviceType, 'urn:schemas-upnp-org:service:WANIPConnection:2');
});

await test('returns null rather than guessing when there is no WAN service', () => {
    const xml = '<root><device><serviceList><service>'
        + '<serviceType>urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1</serviceType>'
        + '<controlURL>/ctl/CommonIfCfg</controlURL></service></serviceList></device></root>';
    assert.equal(findWanService(xml, 'http://192.168.1.1/d.xml'), null);
});

await test('survives truncated and junk documents', () => {
    for (const xml of ['', '<root>', 'not xml at all', '<serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>']) {
        const result = findWanService(xml, 'http://192.168.1.1/d.xml');
        assert.ok(result === null || typeof result.controlUrl === 'string');
    }
});

console.log('\nLifecycle');

await test('close() is safe when nothing was ever mapped', async () => {
    const mapper = new PortMapper({ log: () => {} });
    await mapper.close();
    await mapper.close();
    assert.equal(mapper.mapping, null);
});

await test('open() reports a clean failure with no router present', async () => {
    // Nothing in this environment speaks NAT-PMP or UPnP, so this exercises the
    // path a user behind an unresponsive router hits: a reason, not a hang.
    const mapper = new PortMapper({ log: () => {} });
    const started = Date.now();
    const result = await mapper.open(49999);
    const elapsed = Date.now() - started;

    assert.equal(result.ok, false);
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 20, 'the failure reason should be explanatory');
    // Hosting blocks on this, so the budget matters as much as the outcome.
    assert.ok(elapsed < 4000, `discovery took ${elapsed}ms — too long to block hosting`);
    await mapper.close();
});

await test('concurrent probing keeps the delay flat as candidates grow', async () => {
    // Sequential probing cost one timeout per candidate gateway; the point of
    // racing them is that the total stays close to a single timeout.
    const mapper = new PortMapper({ log: () => {} });
    const candidates = candidateGateways().length;
    const started = Date.now();
    await mapper.open(49998);
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 3500,
        `${candidates} candidates took ${elapsed}ms; probing is not running concurrently`);
    await mapper.close();
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
