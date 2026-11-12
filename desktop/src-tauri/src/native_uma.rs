//! Windows, D3D12 on a cache-coherent UMA adapter (WARP, most integrated
//! GPUs): a slice's values go straight into write-back system memory the
//! cell shader reads, with no GPU copy.
//!
//! wgpu stages every `write_buffer` / `write_texture` through an upload heap,
//! which D3D12 maps write-combined, and the GPU then copies it out. On WARP
//! (the GPU-less CI runner, VMs, remote sessions) that copy is the CPU reading
//! uncached write-combined memory: measured on the runner's AMD EPYC hosts,
//! ~33 ms for one 512 × 512 CT slice into a texture and ~70 ms into a buffer,
//! every scroll step (zoom and window / level, which upload nothing, took
//! ~1 ms); a shader reading a write-combined buffer directly cost ~25 ms a
//! frame. The same slice written into write-back memory and read in place:
//! scroll steps ~4-10 ms. On a cache-coherent UMA GPU, write-back system
//! memory is what device memory is anyway, so this also saves the staging
//! copy there. Discrete GPUs (and any failure here) keep wgpu's upload path.

use windows::Win32::Graphics::Direct3D12::{
    ID3D12Resource, D3D12_CPU_PAGE_PROPERTY_WRITE_BACK, D3D12_FEATURE_ARCHITECTURE1, D3D12_FEATURE_DATA_ARCHITECTURE1,
    D3D12_HEAP_FLAG_NONE, D3D12_HEAP_PROPERTIES, D3D12_HEAP_TYPE_CUSTOM, D3D12_MEMORY_POOL_L0, D3D12_RESOURCE_DESC,
    D3D12_RESOURCE_DIMENSION_BUFFER, D3D12_RESOURCE_FLAG_NONE, D3D12_RESOURCE_STATE_COMMON, D3D12_TEXTURE_LAYOUT_ROW_MAJOR,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_UNKNOWN, DXGI_SAMPLE_DESC};

/// The device is D3D12 on a cache-coherent UMA adapter.
pub fn coherent_uma(device: &wgpu::Device) -> bool {
    // SAFETY: only queries the raw device; the guard is dropped before returning.
    let Some(hal) = (unsafe { device.as_hal::<wgpu::hal::api::Dx12>() }) else {
        return false;
    };
    let mut arch = D3D12_FEATURE_DATA_ARCHITECTURE1::default();
    // SAFETY: `arch` is the struct this feature query fills, with its size.
    let ok = unsafe {
        hal.raw_device().CheckFeatureSupport(
            D3D12_FEATURE_ARCHITECTURE1,
            &mut arch as *mut _ as *mut std::ffi::c_void,
            std::mem::size_of::<D3D12_FEATURE_DATA_ARCHITECTURE1>() as u32,
        )
    }
    .is_ok();
    ok && arch.UMA.as_bool() && arch.CacheCoherentUMA.as_bool()
}

/// A read-only storage buffer holding `bytes` (length a multiple of 4), in
/// write-back system memory. None when the allocation or mapping fails (the
/// caller falls back to wgpu's upload path).
pub fn storage_buffer(device: &wgpu::Device, bytes: &[u8]) -> Option<wgpu::Buffer> {
    let size = bytes.len() as u64;
    if size == 0 || size % 4 != 0 {
        return None;
    }
    let resource = {
        // SAFETY: the raw device is only used to create and fill a new
        // resource; the guard is dropped before wgpu is called again.
        let hal = unsafe { device.as_hal::<wgpu::hal::api::Dx12>() }?;
        let heap = D3D12_HEAP_PROPERTIES {
            Type: D3D12_HEAP_TYPE_CUSTOM,
            CPUPageProperty: D3D12_CPU_PAGE_PROPERTY_WRITE_BACK,
            MemoryPoolPreference: D3D12_MEMORY_POOL_L0,
            CreationNodeMask: 0,
            VisibleNodeMask: 0,
        };
        let desc = D3D12_RESOURCE_DESC {
            Dimension: D3D12_RESOURCE_DIMENSION_BUFFER,
            Alignment: 0,
            Width: size,
            Height: 1,
            DepthOrArraySize: 1,
            MipLevels: 1,
            Format: DXGI_FORMAT_UNKNOWN,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Layout: D3D12_TEXTURE_LAYOUT_ROW_MAJOR,
            Flags: D3D12_RESOURCE_FLAG_NONE,
        };
        let mut resource: Option<ID3D12Resource> = None;
        // SAFETY: valid heap / resource descriptions for a plain buffer.
        unsafe { hal.raw_device().CreateCommittedResource(&heap, D3D12_HEAP_FLAG_NONE, &desc, D3D12_RESOURCE_STATE_COMMON, None, &mut resource) }.ok()?;
        let resource = resource?;
        let mut ptr = std::ptr::null_mut();
        // SAFETY: a CPU-visible buffer of `size` bytes; mapped, filled and
        // unmapped before the GPU can see it (it is not wrapped yet).
        unsafe {
            resource.Map(0, None, Some(&mut ptr)).ok()?;
            if ptr.is_null() {
                return None;
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, bytes.len());
            resource.Unmap(0, None);
        }
        resource
    };
    // SAFETY: created on this device, `size` bytes, fully written (initialised),
    // used only as the read-only storage buffer the descriptor says.
    let buffer = unsafe {
        let raw = wgpu::hal::dx12::Device::buffer_from_raw(resource, size);
        device.create_buffer_from_hal::<wgpu::hal::api::Dx12>(
            raw,
            &wgpu::BufferDescriptor { label: Some("slice (write-back)"), size, usage: wgpu::BufferUsages::STORAGE, mapped_at_creation: false },
        )
    };
    Some(buffer)
}
