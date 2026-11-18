puts "Break 1"
# test comment
break2 = true
$loop_index = 0

def test_puts
    10.times do |i|
        $loop_index = i
        puts "Break 2-#{i}"
        sleep 0.5
    end
end

if break2
    test_puts
else
    puts "Break 3"
end
# test comment
puts "Hello from PicoRuby WASM!!"
