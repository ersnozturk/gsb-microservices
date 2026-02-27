using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Prometheus;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;

namespace MailService.Services;

/// <summary>
/// RabbitMQ Consumer - order_events exchange'ini dinler
/// Sipariş oluşturulduğunda mail gönderim simülasyonu yapar
/// </summary>
public class RabbitMQConsumerService : BackgroundService
{
    private readonly ILogger<RabbitMQConsumerService> _logger;
    private readonly string _rabbitMqUri;
    private readonly string _instanceId;

    // OpenTelemetry için ActivitySource
    private static readonly ActivitySource ActivitySource = new("mail-service");

    // Prometheus metrikleri
    private static readonly Counter MailsSentTotal = Metrics.CreateCounter(
        "mails_sent_total",
        "Gönderilen toplam mail sayisi",
        new CounterConfiguration { LabelNames = new[] { "event" } }
    );

    private static readonly Counter EventsReceivedTotal = Metrics.CreateCounter(
        "events_received_total",
        "Alınan toplam event sayisi",
        new CounterConfiguration { LabelNames = new[] { "event" } }
    );

    public RabbitMQConsumerService(ILogger<RabbitMQConsumerService> logger, IConfiguration configuration)
    {
        _logger = logger;
        _rabbitMqUri = Environment.GetEnvironmentVariable("RABBITMQ_URI") ?? "amqp://guest:guest@localhost:5672";
        _instanceId = Environment.MachineName;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // RabbitMQ hazır olana kadar bekle
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await ConnectAndConsume(stoppingToken);
                break; // Başarılı bağlantı sonrası döngüden çık
            }
            catch (Exception ex)
            {
                _logger.LogError("[{InstanceId}] RabbitMQ bağlantı hatası: {Message}", _instanceId, ex.Message);
                _logger.LogInformation("[{InstanceId}] 5 saniye sonra tekrar denenecek...", _instanceId);
                await Task.Delay(5000, stoppingToken);
            }
        }
    }

    private async Task ConnectAndConsume(CancellationToken stoppingToken)
    {
        var factory = new ConnectionFactory { Uri = new Uri(_rabbitMqUri) };

        using var connection = factory.CreateConnection();
        using var channel = connection.CreateModel();

        // Exchange ve Queue tanımla (fanout exchange - tüm consumer'lara aynı mesaj)
        channel.ExchangeDeclare("order_events", ExchangeType.Fanout, durable: true);
        var queueResult = channel.QueueDeclare("mail_notification", durable: true, exclusive: false, autoDelete: false);
        channel.QueueBind(queueResult.QueueName, "order_events", "");

        _logger.LogInformation("[{InstanceId}] RabbitMQ consumer başlatıldı - \"mail_notification\" dinleniyor", _instanceId);

        var consumer = new EventingBasicConsumer(channel);

        consumer.Received += (model, ea) =>
        {
            try
            {
                // RabbitMQ header'larından traceparent'ı çıkar
                ActivityContext parentContext = default;
                if (ea.BasicProperties.Headers != null &&
                    ea.BasicProperties.Headers.TryGetValue("traceparent", out var traceparentObj))
                {
                    var traceparent = traceparentObj is byte[] bytes
                        ? Encoding.UTF8.GetString(bytes)
                        : traceparentObj?.ToString();

                    if (!string.IsNullOrEmpty(traceparent) &&
                        ActivityContext.TryParse(traceparent, null, out var parsed))
                    {
                        parentContext = parsed;
                    }
                }

                // Parent trace'e bağlı CONSUMER span oluştur
                using var activity = ActivitySource.StartActivity(
                    "consume order.created",
                    ActivityKind.Consumer,
                    parentContext);

                activity?.SetTag("messaging.system", "rabbitmq");
                activity?.SetTag("messaging.source", "order_events");
                activity?.SetTag("messaging.operation", "receive");
                activity?.SetTag("messaging.destination", "mail_notification");

                var body = Encoding.UTF8.GetString(ea.Body.ToArray());
                var eventData = JsonSerializer.Deserialize<OrderCreatedEvent>(body, new JsonSerializerOptions
                {
                    PropertyNameCaseInsensitive = true
                });

                EventsReceivedTotal.WithLabels("order.created").Inc();

                _logger.LogInformation("[{InstanceId}] Event alındı: order.created -> OrderId: {OrderId}, ProductId: {ProductId}, Quantity: {Quantity}",
                    _instanceId, eventData?.OrderId, eventData?.ProductId, eventData?.Quantity);

                _logger.LogInformation("[{InstanceId}] 📧 Mail gönderiliyor...", _instanceId);
                _logger.LogInformation("[{InstanceId}] ✅ Mail gönderildi! Sipariş #{OrderId} için bildirim maili gönderildi.",
                    _instanceId, eventData?.OrderId);
                _logger.LogInformation("[{InstanceId}]    Ürün ID: {ProductId}, Adet: {Quantity}",
                    _instanceId, eventData?.ProductId, eventData?.Quantity);

                MailsSentTotal.WithLabels("order.created").Inc();

                channel.BasicAck(ea.DeliveryTag, false);
            }
            catch (Exception ex)
            {
                _logger.LogError("[{InstanceId}] Mesaj işleme hatası: {Message}", _instanceId, ex.Message);
                channel.BasicNack(ea.DeliveryTag, false, true); // Tekrar kuyruğa koy
            }
        };

        channel.BasicConsume(queue: queueResult.QueueName, autoAck: false, consumer: consumer);

        // Uygulama kapanana kadar bekle
        while (!stoppingToken.IsCancellationRequested)
        {
            await Task.Delay(1000, stoppingToken);
        }
    }
}

/// <summary>
/// RabbitMQ'dan gelen order.created event modeli
/// </summary>
public class OrderCreatedEvent
{
    public int OrderId { get; set; }
    public string? ProductId { get; set; }
    public int Quantity { get; set; }
}
