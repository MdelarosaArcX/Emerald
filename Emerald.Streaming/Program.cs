using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.FileProviders;
using Emerald.Streaming;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container.
builder.Services.AddRazorPages();
builder.Services.Configure<FormOptions>(options =>
{
    options.MultipartBodyLengthLimit = 2L * 1024L * 1024L * 1024L;
});

var app = builder.Build();
var recordingsPath = Path.Combine(app.Environment.ContentRootPath, "Recordings");
Directory.CreateDirectory(recordingsPath);
var obsRecorder = new ObsRecordingService(recordingsPath);
var webRootPath = app.Environment.WebRootPath ?? Path.Combine(app.Environment.ContentRootPath, "wwwroot");
var obsPreview = new ObsPreviewService(webRootPath);

// Configure the HTTP request pipeline.
if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error");
    // The default HSTS value is 30 days. You may want to change this for production scenarios, see https://aka.ms/aspnetcore-hsts.
    app.UseHsts();
}

app.UseHttpsRedirection();
var contentTypes = new FileExtensionContentTypeProvider();
contentTypes.Mappings[".m3u8"] = "application/vnd.apple.mpegurl";
contentTypes.Mappings[".ts"] = "video/mp2t";

app.UseStaticFiles(new StaticFileOptions
{
    ContentTypeProvider = contentTypes,
    OnPrepareResponse = context =>
    {
        if (context.File.Name.EndsWith(".m3u8", StringComparison.OrdinalIgnoreCase))
        {
            context.Context.Response.Headers.CacheControl = "no-store, no-cache, must-revalidate";
        }
    }
});
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(recordingsPath),
    RequestPath = "/recordings"
});

app.UseRouting();

app.UseAuthorization();

app.MapStaticAssets();
app.MapPost("/api/recordings", async (IFormFile file) =>
{
    if (file.Length == 0)
    {
        return Results.BadRequest(new { message = "Recording file is empty." });
    }

    var extension = file.ContentType.Contains("mp4", StringComparison.OrdinalIgnoreCase) ? ".mp4" : ".webm";
    var fileName = $"emerald-preview-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss-fff}{extension}";
    var outputPath = Path.Combine(recordingsPath, fileName);

    await using var output = File.Create(outputPath);
    await file.CopyToAsync(output);

    return Results.Ok(new
    {
        fileName,
        url = $"/recordings/{fileName}",
        size = file.Length,
        contentType = file.ContentType
    });
}).DisableAntiforgery();
app.MapGet("/api/obs-recording/status", () => Results.Ok(obsRecorder.Status));
app.MapGet("/api/obs-recordings", () =>
{
    var files = Directory.EnumerateFiles(recordingsPath)
        .Select(path => new FileInfo(path))
        .OrderByDescending(file => file.LastWriteTimeUtc)
        .Take(100)
        .Select(file => new
        {
            fileName = file.Name,
            url = $"/recordings/{file.Name}",
            size = file.Length,
            createdAt = file.CreationTimeUtc
        });

    return Results.Ok(files);
});
app.MapPost("/api/obs-recording/start", (ObsRecordingRequest request) =>
{
    try
    {
        return Results.Ok(obsRecorder.Start(request));
    }
    catch (Exception exception)
    {
        return Results.BadRequest(new { message = exception.Message });
    }
});
app.MapPost("/api/obs-recording/stop", () => Results.Ok(obsRecorder.Stop()));
app.MapGet("/api/obs-preview/status", () => Results.Ok(obsPreview.Status));
app.MapPost("/api/obs-preview/start", (ObsPreviewRequest request) =>
{
    try
    {
        return Results.Ok(obsPreview.Start(request));
    }
    catch (Exception exception)
    {
        return Results.BadRequest(new { message = exception.Message });
    }
});
app.MapPost("/api/obs-preview/stop", () => Results.Ok(obsPreview.Stop()));
app.MapPost("/api/obs-stream/probe", async (ObsStreamProbeRequest request, CancellationToken cancellationToken) =>
{
    try
    {
        return Results.Ok(await ObsStreamProbeService.ProbeAsync(request, cancellationToken));
    }
    catch (Exception exception)
    {
        return Results.BadRequest(new { message = exception.Message });
    }
});
app.MapRazorPages()
   .WithStaticAssets();

app.Run();
