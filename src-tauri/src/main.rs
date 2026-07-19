// Windows release'te ekstra konsol penceresini engeller, KALDIRMAYIN!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    helmio_lib::run()
}
