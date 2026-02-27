# Build aşaması
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

# Önce csproj kopyala ve restore yap (layer caching)
COPY src/MailService.csproj ./
RUN dotnet restore

# Kaynak kodları kopyala ve publish et
COPY src/ ./
RUN dotnet publish -c Release -o /app/publish

# Runtime aşaması (daha küçük image)
FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /app/publish .

EXPOSE 5050

ENTRYPOINT ["dotnet", "MailService.dll"]
