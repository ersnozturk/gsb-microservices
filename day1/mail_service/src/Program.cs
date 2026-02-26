using MailService.Services;
using Prometheus;

var builder = WebApplication.CreateBuilder(args);

// RabbitMQ Consumer'ı background service olarak ekle
builder.Services.AddHostedService<RabbitMQConsumerService>();

var app = builder.Build();

// ========================================
// Prometheus Metrikleri
// ========================================
app.UseHttpMetrics();
app.MapMetrics(); // /metrics endpoint'i

// ========================================
// Health Check
// ========================================
app.MapGet("/health", () => Results.Ok(new
{
    status = "ok",
    service = "mail-service",
    instance = Environment.MachineName
}));

// ========================================
// Ana Sayfa
// ========================================
app.MapGet("/", () => Results.Ok(new
{
    service = "mail-service",
    instance = Environment.MachineName,
    description = "Mail Service - order.created eventlerini dinler ve mail bildirimi gönderir (.NET)",
    endpoints = new
    {
        health = "GET /health",
        metrics = "GET /metrics"
    }
}));

app.Run();
