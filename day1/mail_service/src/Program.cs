using MailService.Services;
using Prometheus;

var builder = WebApplication.CreateBuilder(args);

// RabbitMQ Consumer'ı background service olarak ekle
builder.Services.AddHostedService<RabbitMQConsumerService>();

var app = builder.Build();

// ========================================
// Prometheus Metrikleri
// ========================================
var httpRequestsTotal = Metrics.CreateCounter(
    "http_requests_total",
    "Toplam HTTP istek sayisi",
    new CounterConfiguration { LabelNames = new[] { "method", "path", "status" } }
);

app.UseHttpMetrics();
app.MapMetrics(); // /metrics endpoint'i

// ========================================
// Health Check
// ========================================
app.MapGet("/health", () =>
{
    httpRequestsTotal.WithLabels("GET", "/health", "200").Inc();
    return Results.Ok(new
    {
        status = "ok",
        service = "mail-service",
        instance = Environment.MachineName
    });
});

// ========================================
// Mail Gönderme Endpoint'i (HTTP ile)
// ========================================
app.MapPost("/send", async (HttpRequest request) =>
{
    try
    {
        var body = await request.ReadFromJsonAsync<MailRequest>();

        if (body == null || string.IsNullOrEmpty(body.To) || string.IsNullOrEmpty(body.Subject))
        {
            httpRequestsTotal.WithLabels("POST", "/send", "400").Inc();
            return Results.BadRequest(new { error = "to ve subject alanları zorunludur" });
        }

        var instanceId = Environment.MachineName;

        // Mail gönderim simülasyonu
        Console.WriteLine($"[{instanceId}] 📧 HTTP Mail isteği alındı");
        Console.WriteLine($"[{instanceId}]    To: {body.To}");
        Console.WriteLine($"[{instanceId}]    Subject: {body.Subject}");
        Console.WriteLine($"[{instanceId}]    Body: {body.Body ?? "(boş)"}");
        Console.WriteLine($"[{instanceId}] ✅ Mail gönderildi!");

        httpRequestsTotal.WithLabels("POST", "/send", "200").Inc();

        return Results.Ok(new
        {
            status = "sent",
            service = "mail-service",
            instance = instanceId,
            mail = new
            {
                to = body.To,
                subject = body.Subject,
                body = body.Body
            }
        });
    }
    catch (Exception ex)
    {
        httpRequestsTotal.WithLabels("POST", "/send", "500").Inc();
        return Results.Json(new { error = ex.Message }, statusCode: 500);
    }
});

// ========================================
// Ana Sayfa
// ========================================
app.MapGet("/", () =>
{
    httpRequestsTotal.WithLabels("GET", "/", "200").Inc();
    return Results.Ok(new
    {
        service = "mail-service",
        instance = Environment.MachineName,
        description = "Mail Service - order.created eventlerini dinler ve HTTP ile mail gönderir (.NET)",
        endpoints = new
        {
            health = "GET /health",
            metrics = "GET /metrics",
            send = "POST /send { to, subject, body }"
        }
    });
});

app.Run();

// ========================================
// DTO
// ========================================
public record MailRequest(string To, string Subject, string? Body);
