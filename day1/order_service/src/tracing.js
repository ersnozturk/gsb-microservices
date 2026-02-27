// ========================================
// OpenTelemetry Tracing - Order Service
// Bu dosya index.js'den ÖNCE yüklenir: node -r ./tracing.js index.js
// ========================================
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { Resource } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME } = require('@opentelemetry/semantic-conventions');

const serviceName = process.env.OTEL_SERVICE_NAME || 'order-service';
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';

// Trace'den hariç tutulacak URL'ler
const IGNORED_PATHS = ['/metrics', '/health'];

const sdk = new NodeSDK({
    resource: new Resource({
        [ATTR_SERVICE_NAME]: serviceName,
    }),
    traceExporter: new OTLPTraceExporter({
        url: `${otlpEndpoint}/v1/traces`,
    }),
    instrumentations: [
        getNodeAutoInstrumentations({
            '@opentelemetry/instrumentation-http': {
                enabled: true,
                // /metrics ve /health isteklerini trace'den hariç tut
                ignoreIncomingRequestHook: (req) => IGNORED_PATHS.includes(req.url),
                // Jaeger'a giden istekleri de hariç tut
                ignoreOutgoingRequestHook: (opts) => {
                    const path = opts.path || '';
                    return path.includes('/v1/traces');
                },
                // Span adını "METHOD /path" olarak ayarla
                requestHook: (span, request) => {
                    if (request?.url || request?.path) {
                        const method = request.method || 'GET';
                        const url = request.url || request.path || '/';
                        span.updateName(`${method} ${url}`);
                    }
                },
            },
            '@opentelemetry/instrumentation-pg': { enabled: true },
            '@opentelemetry/instrumentation-fs': { enabled: false },
        }),
    ],
});

sdk.start();
console.log(`[OpenTelemetry] ${serviceName} tracing başlatıldı -> ${otlpEndpoint}`);

process.on('SIGTERM', () => sdk.shutdown());
process.on('SIGINT', () => sdk.shutdown());
